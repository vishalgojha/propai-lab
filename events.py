"""Simple async event bus for PropAI.

Events flow through the pipeline and are pushed to frontend via SSE.
"""
import asyncio
import json
from datetime import datetime, timezone
from typing import Callable, Any

Subscriber = Callable[[str, dict], Any]


class EventBus:
    def __init__(self):
        self._subscribers: dict[str, list[Subscriber]] = {}
        self._sse_queues: list[asyncio.Queue] = []

    def publish(self, event_type: str, data: dict | None = None):
        """Publish an event to all subscribers and SSE clients."""
        event = {
            "type": event_type,
            "data": data or {},
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }
        # Notify callbacks
        for cb in self._subscribers.get(event_type, []):
            try:
                cb(event_type, event)
            except Exception:
                pass
        # Push to SSE clients
        for q in self._sse_queues:
            try:
                q.put_nowait(event)
            except asyncio.QueueFull:
                pass

    def subscribe(self, event_type: str, callback: Subscriber):
        if event_type not in self._subscribers:
            self._subscribers[event_type] = []
        self._subscribers[event_type].append(callback)

    def sse_queue(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=100)
        self._sse_queues.append(q)
        return q

    def remove_queue(self, q: asyncio.Queue):
        if q in self._sse_queues:
            self._sse_queues.remove(q)


# Global singleton
_bus: EventBus | None = None


def get_bus() -> EventBus:
    global _bus
    if _bus is None:
        _bus = EventBus()
    return _bus


def reset_bus():
    global _bus
    _bus = None
