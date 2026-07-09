"""
Source Adapters.

Each adapter implements a common interface:
  - fetch() -> list[dict]
  - normalize(rec: dict) -> dict

The adapter is responsible for scraping, parsing, and producing
raw observation records. The pipeline handles resolution + storage.

Adapter naming: <source_name>_adapter.py
"""
from typing import Protocol


class ObservationAdapter(Protocol):
    """Protocol for all source adapters."""
    
    source: str
    
    def fetch(self, **kwargs) -> list[dict]:
        """Fetch raw observations from the source."""
        ...
