"""Simple async event bus for PropAI."""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from typing import Any, Callable

Subscriber = Callable[[str, dict], Any]


class EventBus:
    def __init__(self):
        self._subscribers: dict[str, list[Subscriber]] = {}
        self._sse_queues: list[asyncio.Queue] = []

    def publish(self, event_type: str, data: dict | None = None):
        event = {
            "type": event_type,
            "data": data or {},
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }
        for callback in self._subscribers.get(event_type, []):
            try:
                callback(event_type, event)
            except Exception:
                pass
        for queue in self._sse_queues:
            try:
                queue.put_nowait(event)
            except asyncio.QueueFull:
                pass

    def subscribe(self, event_type: str, callback: Subscriber):
        self._subscribers.setdefault(event_type, []).append(callback)

    def sse_queue(self) -> asyncio.Queue:
        queue: asyncio.Queue = asyncio.Queue(maxsize=100)
        self._sse_queues.append(queue)
        return queue

    def remove_queue(self, queue: asyncio.Queue):
        if queue in self._sse_queues:
            self._sse_queues.remove(queue)


_bus: EventBus | None = None


def get_bus() -> EventBus:
    global _bus
    if _bus is None:
        _bus = EventBus()
    return _bus


def reset_bus():
    global _bus
    _bus = None
