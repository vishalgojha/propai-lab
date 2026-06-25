"""
Source registry — discoverable collection of all data sources.

Sources register themselves by name. The scheduler and API
use the registry to enumerate and access sources.
"""

from typing import Optional
from sources.base import BaseSource


class SourceRegistry:
    """Global registry of source implementations."""

    def __init__(self):
        self._sources: dict[str, BaseSource] = {}

    def register(self, source: BaseSource):
        """Register a source instance by its name."""
        self._sources[source.name] = source

    def get(self, name: str) -> Optional[BaseSource]:
        """Get a source by name, or None."""
        return self._sources.get(name)

    def all(self) -> list[BaseSource]:
        """Return all registered sources."""
        return list(self._sources.values())

    def names(self) -> list[str]:
        """Return names of all registered sources."""
        return list(self._sources.keys())

    def __contains__(self, name: str) -> bool:
        return name in self._sources

    def __repr__(self) -> str:
        return f"<SourceRegistry: {', '.join(self.names())}>"


# ── Global singleton ──────────────────────────────────────────────

_registry: Optional[SourceRegistry] = None


def get_registry() -> SourceRegistry:
    """Get or create the global source registry singleton."""
    global _registry
    if _registry is None:
        _registry = SourceRegistry()
        # Auto-register built-in sources
        from sources.whatsapp import WhatsAppSource
        _registry.register(WhatsAppSource())
    return _registry
