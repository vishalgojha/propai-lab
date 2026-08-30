"""Small Gmail poller that forwards labelled mail into PropAI.

This deliberately has no workflow UI and never mutates Gmail. It repeatedly
reads a label, relies on PropAI's Gmail message ID for idempotency, and leaves
classification/extraction to the existing worker.
"""

from __future__ import annotations

import base64
import html
import json
import logging
import os
import re
import time
import urllib.parse
import urllib.request
from email.utils import parsedate_to_datetime
from html.parser import HTMLParser


LOG = logging.getLogger("gmail-ingestor")


class _HTMLText(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.parts: list[str] = []

    def handle_data(self, data: str) -> None:
        self.parts.append(data)

    def text(self) -> str:
        value = re.sub(r"\n{3,}", "\n\n", "\n".join(self.parts)).strip()
        return re.sub(r"\s+", " ", value).strip()


def _request(url: str, *, method: str = "GET", token: str = "", data: bytes | None = None) -> dict:
    headers = {"Accept": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if data is not None:
        headers["Content-Type"] = "application/x-www-form-urlencoded"
    req = urllib.request.Request(url, headers=headers, method=method, data=data)
    with urllib.request.urlopen(req, timeout=45) as response:
        return json.loads(response.read().decode("utf-8"))


def _refresh_access_token() -> str:
    form = urllib.parse.urlencode({
        "client_id": os.environ["GMAIL_CLIENT_ID"],
        "client_secret": os.environ["GMAIL_CLIENT_SECRET"],
        "refresh_token": os.environ["GMAIL_REFRESH_TOKEN"],
        "grant_type": "refresh_token",
    }).encode()
    result = _request("https://oauth2.googleapis.com/token", method="POST", data=form)
    return str(result["access_token"])


def _header(headers: list[dict], name: str) -> str:
    wanted = name.casefold()
    for item in headers:
        if str(item.get("name", "")).casefold() == wanted:
            return str(item.get("value") or "").strip()
    return ""


def _decode_body(value: str) -> str:
    if not value:
        return ""
    padded = value + "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode(padded.encode()).decode("utf-8", errors="replace")


def _walk_parts(part: dict, text_parts: list[str], html_parts: list[str], attachments: list[dict]) -> None:
    mime = str(part.get("mimeType") or "")
    body = part.get("body") or {}
    data = _decode_body(str(body.get("data") or ""))
    if mime == "text/plain" and data:
        text_parts.append(data)
    elif mime == "text/html" and data:
        html_parts.append(data)
    filename = str(part.get("filename") or "").strip()
    if filename:
        attachments.append({
            "filename": filename,
            "mime_type": mime,
            "size": int(body.get("size") or 0),
            "attachment_id": body.get("attachmentId"),
        })
    for child in part.get("parts") or []:
        _walk_parts(child, text_parts, html_parts, attachments)


def _email_payload(message: dict, label: str) -> dict:
    payload = message.get("payload") or {}
    text_parts: list[str] = []
    html_parts: list[str] = []
    attachments: list[dict] = []
    _walk_parts(payload, text_parts, html_parts, attachments)
    body = "\n\n".join(p.strip() for p in text_parts if p.strip())
    if not body and html_parts:
        parser = _HTMLText()
        parser.feed("\n".join(html_parts))
        body = html.unescape(parser.text())
    headers = payload.get("headers") or []
    received = _header(headers, "Date")
    if received:
        try:
            received = parsedate_to_datetime(received).isoformat()
        except (TypeError, ValueError, IndexError):
            pass
    return {
        "message_id": str(message.get("id") or ""),
        "subject": _header(headers, "Subject"),
        "body": body,
        "sender": _header(headers, "From"),
        "recipients": [_header(headers, "To")],
        "received_at": received or None,
        "label": label,
        "attachments": attachments,
        "raw_email": {"gmail_id": message.get("id"), "thread_id": message.get("threadId")},
    }


def poll_once(access_token: str) -> int:
    user = urllib.parse.quote(os.environ.get("GMAIL_USER", "me"), safe="")
    query = os.environ.get("GMAIL_QUERY", "label:PropAI/Incoming newer_than:7d")
    label = os.environ.get("GMAIL_LABEL", "PropAI/Incoming")
    list_url = (
        f"https://gmail.googleapis.com/gmail/v1/users/{user}/messages?"
        + urllib.parse.urlencode({"q": query, "maxResults": "50"})
    )
    listed = _request(list_url, token=access_token)
    sent = 0
    api_url = os.environ["PROPAI_API_URL"].rstrip("/") + "/email-ingest"
    for item in listed.get("messages") or []:
        message_id = str(item.get("id") or "")
        if not message_id:
            continue
        detail_url = f"https://gmail.googleapis.com/gmail/v1/users/{user}/messages/{message_id}?format=full"
        payload = _email_payload(_request(detail_url, token=access_token), label)
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        req = urllib.request.Request(
            api_url,
            headers={
                "Authorization": f"Bearer {os.environ['PROPAI_EMAIL_INGEST_TOKEN']}",
                "Content-Type": "application/json",
            },
            method="POST",
            data=body,
        )
        try:
            with urllib.request.urlopen(req, timeout=45) as response:
                result = json.loads(response.read().decode("utf-8"))
            if result.get("status") in {"accepted", "duplicate"}:
                sent += 1
        except Exception:
            LOG.exception("failed forwarding Gmail message %s", message_id)
    return sent


def main() -> None:
    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
    interval = max(30, int(os.environ.get("GMAIL_POLL_SECONDS", "60")))
    while True:
        try:
            count = poll_once(_refresh_access_token())
            LOG.info("poll complete: forwarded=%s", count)
        except Exception:
            LOG.exception("Gmail poll failed")
        time.sleep(interval)


if __name__ == "__main__":
    main()
