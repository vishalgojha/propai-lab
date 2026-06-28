"""Compatibility package for running the lab from this checkout root."""

from pathlib import Path

__path__.append(str(Path(__file__).resolve().parent.parent))
