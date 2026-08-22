"""Authenticated access to the self-hosted living architecture artifacts."""

from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException

from routers.common import require_user


router = APIRouter()
ROOT = Path(__file__).resolve().parents[1]


def _read(relative: str) -> str:
    try:
        return (ROOT / relative).read_text(encoding="utf-8")
    except OSError as exc:
        raise HTTPException(503, "Architecture artifacts are not available") from exc


@router.get("/api/architecture")
async def architecture_artifacts(user: dict = Depends(require_user)):
    """Return the hand-maintained contract and generated Mermaid sources."""
    return {
        "architecture": _read("architecture.md"),
        "schema_diagram": _read("docs/architecture/generated/schema.mmd"),
        "dependency_diagram": _read("docs/architecture/generated/dependencies.mmd"),
        "openapi_path": "/api/docs",
    }
