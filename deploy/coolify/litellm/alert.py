#!/usr/bin/env python
"""LLM gateway health alerting.

Runs on a schedule (Coolify scheduled task / cron, every 15-30 min).
Queries the llm_routing_log failure-rate function and, for any provider
breaching the threshold, sends an ops alert over the existing WhatsApp
ingestor channel (reused from app.py::_notify_broker_of_lead).

Env required:
  SUPABASE_URL, SUPABASE_SERVICE_KEY  — read llm_routing_log
  INGESTOR_INTERNAL_URL               — whatsmeow send endpoint
  ALERT_WHATSAPP_NUMBERS              — comma-separated JIDs/phones to notify
  (optional) ALERT_WINDOW_MINUTES=30, ALERT_MIN_CALLS=10, ALERT_MAX_FAILURE_RATE=0.5

No new alerting channel is introduced — we reuse the WhatsApp ingestor.
"""
from __future__ import annotations

import os
import sys

import httpx
from supabase import create_client


def get_providers_to_alert() -> list[dict]:
    url = os.environ["SUPABASE_URL"]
    key = os.environ["SUPABASE_SERVICE_KEY"]
    supabase = create_client(url, key)
    res = supabase.rpc(
        "llm_provider_failure_rates",
        {
            "p_window_minutes": int(os.getenv("ALERT_WINDOW_MINUTES", "30")),
            "p_min_calls": int(os.getenv("ALERT_MIN_CALLS", "10")),
            "p_max_failure_rate": float(os.getenv("ALERT_MAX_FAILURE_RATE", "0.5")),
        },
    ).execute()
    return res.data or []


def send_whatsapp(text: str) -> None:
    numbers = [n.strip() for n in os.getenv("ALERT_WHATSAPP_NUMBERS", "").split(",") if n.strip()]
    if not numbers:
        print("ALERT (no ALERT_WHATSAPP_NUMBERS set):", text)
        return
    base = os.getenv("INGESTOR_INTERNAL_URL", "").rstrip("/")
    if not base:
        print("ALERT (no INGESTOR_INTERNAL_URL):", text)
        return
    for num in numbers:
        digits = "".join(c for c in num if c.isdigit())
        if len(digits) == 10:
            digits = "91" + digits
        elif not digits.startswith("91"):
            digits = "91" + digits[-10:]
        remote_jid = f"{digits}@s.whatsapp.net"
        try:
            httpx.post(
                f"{base}/send-message",
                json={"remoteJid": remote_jid, "text": text},
                timeout=10,
            )
        except Exception as exc:
            print(f"failed to alert {num}: {exc}")


def main() -> int:
    try:
        bad = get_providers_to_alert()
    except Exception as exc:
        print(f"alert query failed: {exc}")
        return 1
    if not bad:
        print("llm gateway: all providers healthy")
        return 0
    lines = ["⚠️ PropAI LLM gateway: provider health degraded"]
    for p in bad:
        lines.append(
            f"• {p['provider_used']}: {p['failed_calls']}/{p['total_calls']} "
            f"failed ({p['failure_rate']*100:.0f}%) last err: {p['last_error_message']}"
        )
    msg = "\n".join(lines)
    send_whatsapp(msg)
    print(msg)
    return 0


if __name__ == "__main__":
    sys.exit(main())
