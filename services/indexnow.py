"""Best-effort IndexNow notifications for public listing changes.

IndexNow is optional. Without INDEXNOW_KEY this module is a no-op, so local
development and deployments that have not completed host verification are
not affected.
"""

import logging
import os
import threading
import httpx

_logger = logging.getLogger(__name__)


def notify_public_listing(listing_id: int) -> None:
    """Notify IndexNow asynchronously after a listing is persisted.

    The numeric slug is intentionally accepted by the public detail route and
    redirected to its canonical slug. This keeps the ingestion layer from
    duplicating the frontend's slug algorithm while still notifying the
    correct listing resource.
    """
    key = (os.getenv("INDEXNOW_KEY") or "").strip()
    base = (os.getenv("PUBLIC_SITE_URL") or os.getenv("NEXT_PUBLIC_SITE_URL") or "https://www.propai.live").strip().rstrip("/")
    if not key or listing_id <= 0:
        return

    url = f"{base}/listings/{listing_id}/{listing_id}"
    key_location = f"{base}/api/indexnow-key"

    def send() -> None:
        try:
            response = httpx.get(
                "https://api.indexnow.org/indexnow",
                params={"url": url, "key": key, "keyLocation": key_location},
                timeout=8.0,
            )
            if response.status_code not in (200, 202):
                _logger.warning("IndexNow notification failed: status=%s listing_id=%s", response.status_code, listing_id)
        except Exception:
            _logger.exception("IndexNow notification error for listing_id=%s", listing_id)

    threading.Thread(target=send, name="indexnow-listing", daemon=True).start()
