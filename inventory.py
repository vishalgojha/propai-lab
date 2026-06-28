"""Canonical inventory helpers."""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import asdict, is_dataclass
from typing import Any


def _text(value: Any) -> str:
    if value is None:
        return ""
    text = str(value).strip().lower()
    text = re.sub(r"[\u200b-\u200d\ufeff]", "", text)
    text = re.sub(r"[^a-z0-9]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def _digits(value: Any) -> str:
    if value is None:
        return ""
    return "".join(ch for ch in str(value) if ch.isdigit())


def _intish(value: Any) -> str:
    if value is None or value == "":
        return ""
    try:
        return str(int(round(float(value))))
    except (TypeError, ValueError):
        return _text(value)


def _first_text(*values: Any) -> str:
    for value in values:
        text = _text(value)
        if text:
            return text
    return ""


def _mapping(obj: Any) -> dict[str, Any]:
    if obj is None:
        return {}
    if isinstance(obj, dict):
        return obj
    if is_dataclass(obj):
        return asdict(obj)
    return getattr(obj, "__dict__", {})


def listing_signature_fields(parsed: Any, raw_sender: str = "", group_name: str = "") -> dict[str, str]:
    data = _mapping(parsed)
    return {
        "intent": _text(data.get("intent")),
        "bhk": _text(data.get("bhk")),
        "price": _intish(data.get("price")),
        "area_sqft": _intish(data.get("area_sqft")),
        "furnishing": _text(data.get("furnishing")),
        "location": _first_text(
            data.get("micro_market"),
            data.get("location_raw"),
            data.get("building_name"),
            data.get("landmark_name"),
        ),
        "building": _text(data.get("building_name")),
        "landmark": _text(data.get("landmark_name")),
        "broker": _first_text(
            data.get("broker_phone"),
            data.get("profile_name"),
            data.get("broker_name"),
            raw_sender,
        ),
    }


def listing_fingerprint(parsed: Any, raw_sender: str = "", group_name: str = "") -> str:
    payload = listing_signature_fields(parsed, raw_sender=raw_sender, group_name=group_name)
    blob = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


def listing_label(parsed: Any) -> str:
    data = _mapping(parsed)
    parts = [
        _text(data.get("bhk")).upper(),
        _text(data.get("price_unit")).upper(),
        _first_text(
            data.get("micro_market"),
            data.get("location_raw"),
            data.get("building_name"),
            data.get("landmark_name"),
        ).title(),
    ]
    return " ".join(part for part in parts if part)
