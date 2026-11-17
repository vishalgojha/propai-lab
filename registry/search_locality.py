"""Read-only search scopes from PropAI's persisted locality reference.

This resolves search geography, not extraction or publication permissions.
No nearby expansion, building-name inference, or replacement locality list.
"""
from __future__ import annotations

from dataclasses import dataclass
import json

from registry.locality_resolver import normalize_locality


class AmbiguousLocality(ValueError):
    pass


@dataclass(frozen=True)
class LocalitySearchScope:
    requested: str
    status: str
    labels: tuple[str, ...]
    locality_ids: tuple[int, ...]

    def as_dict(self) -> dict:
        return {
            "requested": self.requested,
            "status": self.status,
            "included_localities": list(self.labels),
            "locality_ids": list(self.locality_ids),
            "nearby_expanded": False,
        }

    def postgrest_filter(self) -> str:
        # Quotes protect PostgREST filter grammar. ilike is case-insensitive
        # equality here: wildcard characters are not accepted as literal areas.
        predicates = [
            f'{field}.ilike.{json.dumps(label, ensure_ascii=False)}'
            for field in ("micro_market", "locality_raw", "locality_resolved")
            for label in self.labels
        ]
        text_filter = "or(" + ",".join(predicates) + ")"
        if self.locality_ids:
            ids = ",".join(str(value) for value in self.locality_ids)
            # A persisted relational identity wins over conflicting raw labels.
            return f"locality_id.in.({ids}),and(locality_id.is.null,{text_filter})"
        return f"and(locality_id.is.null,{text_filter})"


def resolve_search_locality(requested: str, reference: list[dict]) -> LocalitySearchScope:
    requested = requested.strip()
    if not requested or len(requested) > 160 or any(c in requested for c in "*%_\\\r\n"):
        raise ValueError("Use a literal locality name, not a wildcard")
    target = normalize_locality(requested)
    rows = [r for r in reference if str(r.get("sub_locality") or "").strip()]

    def identity(row: dict) -> str:
        return normalize_locality(row["sub_locality"])

    def aliases(row: dict) -> list[str]:
        values = [row["sub_locality"], *(row.get("alternate_names") or [])]
        canonical = row.get("canonical_locality")
        # Some historical rows store the parent in canonical_locality. That
        # compatibility field must not turn a child search into its siblings.
        if canonical and normalize_locality(canonical) != normalize_locality(row.get("parent_locality")):
            values.append(canonical)
        return [str(v).strip() for v in values if v and str(v).strip()]

    matched = [r for r in rows if target in {normalize_locality(v) for v in aliases(r)}]
    names = {identity(r) for r in matched}
    parent_keys = {normalize_locality(r.get("parent_locality")) for r in matched}
    if len(names) > 1 or len(parent_keys) > 1:
        raise AmbiguousLocality("Locality alias matches multiple reference areas; use the specific area name")
    root = next(iter(names), target)
    # Parent-only records are useful even without a separate row for the parent.
    known_parent = any(normalize_locality(r.get("parent_locality")) == root for r in rows)
    if not matched and not known_parent:
        return LocalitySearchScope(requested, "exact_unmapped", (requested,), ())

    included = {root}
    while True:
        expanded = included | {
            identity(r) for r in rows
            if normalize_locality(r.get("parent_locality")) in included
        }
        if expanded == included:
            break
        included = expanded
    selected = [r for r in rows if identity(r) in included]
    labels = {requested}
    ids = set()
    for row in selected:
        labels.update(aliases(row))
        if row.get("id") is not None:
            ids.add(int(row["id"]))
    if len(labels) > 100 or any(any(c in v for c in "*%_\\\r\n") for v in labels):
        raise ValueError("Locality reference scope cannot be represented safely; use a more specific area")
    labels = sorted(labels, key=lambda v: (normalize_locality(v), v))
    return LocalitySearchScope(
        requested, "reference_descendants" if len(included) > 1 else "reference_exact",
        tuple(labels), tuple(sorted(ids)),
    )
