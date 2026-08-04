"""Small, dependency-free request protection primitives.

The API is deployed as more than one service/instance, so this in-process
limiter is intentionally a first line of defence, not a distributed quota
system.  Production deployments should set the same limits at the edge or
back them with Redis when horizontally scaled.
"""

from __future__ import annotations

import hashlib
import os
import time
from collections import defaultdict, deque
from threading import Lock
from typing import Any

from fastapi import Request


DEFAULT_MAX_PAGE_SIZE = max(1, int(os.getenv("PROPAI_MAX_PAGE_SIZE", "100")))
DEFAULT_MAX_OFFSET = max(0, int(os.getenv("PROPAI_MAX_OFFSET", "10000")))


def bounded_page(limit: int, offset: int = 0, *, maximum: int = DEFAULT_MAX_PAGE_SIZE) -> tuple[int, int]:
    """Normalize untrusted pagination values before they reach storage."""
    return max(1, min(int(limit or 1), maximum)), max(0, min(int(offset or 0), DEFAULT_MAX_OFFSET))


def request_identity(request: Request) -> str:
    """Return a non-secret bucket key for a request."""
    auth = request.headers.get("authorization", "")
    if auth:
        digest = hashlib.sha256(auth.encode("utf-8")).hexdigest()[:24]
        return f"auth:{digest}"
    return f"ip:{request.client.host if request.client else 'unknown'}"


class SlidingWindowLimiter:
    def __init__(self) -> None:
        self._events: dict[tuple[str, str], deque[float]] = defaultdict(deque)
        self._lock = Lock()
        self._last_cleanup = 0.0

    def allow(self, key: str, bucket: str, limit: int, window_seconds: float = 60.0) -> tuple[bool, int, int]:
        now = time.monotonic()
        cutoff = now - window_seconds
        with self._lock:
            if now - self._last_cleanup >= 60.0:
                for bucket_key in tuple(self._events):
                    if not self._events[bucket_key]:
                        self._events.pop(bucket_key, None)
                self._last_cleanup = now
            events = self._events[(key, bucket)]
            while events and events[0] <= cutoff:
                events.popleft()
            remaining = max(0, limit - len(events))
            if remaining <= 0:
                retry_after = max(1, int(events[0] + window_seconds - now)) if events else 1
                return False, 0, retry_after
            events.append(now)
            return True, remaining - 1, 0


class TTLCache:
    """Bounded in-process cache for small, non-sensitive read results."""

    def __init__(self, max_entries: int = 512, ttl_seconds: float = 30.0) -> None:
        self.max_entries = max(1, max_entries)
        self.ttl_seconds = max(0.0, ttl_seconds)
        self._values: dict[str, tuple[float, Any]] = {}
        self._lock = Lock()

    def get(self, key: str) -> Any | None:
        now = time.monotonic()
        with self._lock:
            item = self._values.get(key)
            if not item:
                return None
            expires_at, value = item
            if expires_at <= now:
                self._values.pop(key, None)
                return None
            return value

    def set(self, key: str, value: Any) -> None:
        with self._lock:
            if len(self._values) >= self.max_entries and key not in self._values:
                oldest = min(self._values, key=lambda candidate: self._values[candidate][0])
                self._values.pop(oldest, None)
            self._values[key] = (time.monotonic() + self.ttl_seconds, value)
