"""AI correction pass for incomplete or low-confidence parsed observations."""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ai_chat_engine import MODEL, get_client
from config import DOUBLEWORD_API_KEY, STATUS_FILE, SUPABASE_SERVICE_KEY, SUPABASE_URL
from storage.supabase import SupabaseStorage

logger = logging.getLogger(__name__)

DEFAULT_THRESHOLD = 0.7
DEFAULT_MAX_CALLS = 500
INPUT_COST_PER_MILLION = 0.14
OUTPUT_COST_PER_MILLION = 1.00
PROMPT_PATH = Path(__file__).parent / "prompts" / "qwen-correction-layer-prompt.md"
STATUS_PATH = STATUS_FILE.with_name("ai_correction_status.json")

CORRECTABLE_FIELDS = (
    "message_type", "bhk", "price", "price_unit", "area_sqft", "furnishing",
    "location_raw", "building_name", "landmark_name", "street_name", "area",
    "micro_market", "developer", "broker_name", "broker_phone", "intent",
    "principal", "profile_name",
)
NUMERIC_FIELDS = {
    "price", "area_sqft",
}
PARTIAL_SIGNAL_FIELDS = ("location_raw", "building_name", "price", "price_unit")


class CorrectionError(RuntimeError):
    """Raised when a correction response is unsafe to persist."""


@dataclass
class RunSummary:
    selected_count: int = 0
    processed_count: int = 0
    corrected_count: int = 0
    reused_count: int = 0
    skipped_count: int = 0
    api_calls: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    estimated_cost_usd: float = 0.0
    status: str = "running"
    error: str | None = None


def _env_int(name: str, default: int) -> int:
    try:
        return max(0, int(os.getenv(name, str(default))))
    except ValueError as exc:
        raise CorrectionError(f"{name} must be an integer") from exc


def _raw_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _load_prompt() -> str:
    try:
        prompt = PROMPT_PATH.read_text(encoding="utf-8").strip()
    except OSError as exc:
        raise CorrectionError(f"Correction prompt unavailable: {PROMPT_PATH}") from exc
    if not prompt:
        raise CorrectionError(f"Correction prompt is empty: {PROMPT_PATH}")
    return prompt


def _draft(row: dict[str, Any]) -> dict[str, Any]:
    return {field: row.get(field) for field in CORRECTABLE_FIELDS}


def _is_partial(row: dict[str, Any]) -> bool:
    missing_signal = any(row.get(field) is None for field in PARTIAL_SIGNAL_FIELDS)
    populated = any(row.get(field) is not None for field in CORRECTABLE_FIELDS)
    return missing_signal and populated


def _needs_correction(row: dict[str, Any], threshold: float) -> bool:
    confidence = row.get("confidence")
    try:
        low_confidence = confidence is None or float(confidence) < threshold
    except (TypeError, ValueError):
        low_confidence = True
    return low_confidence or _is_partial(row)


def _validate_response(payload: Any, draft: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise CorrectionError("Model response must be a JSON object")
    expected = set(CORRECTABLE_FIELDS) | {"corrected_fields", "correction_confidence"}
    actual = set(payload)
    if actual != expected:
        missing = sorted(expected - actual)
        extra = sorted(actual - expected)
        raise CorrectionError(f"Model response schema mismatch; missing={missing}, extra={extra}")

    corrected_fields = payload["corrected_fields"]
    if not isinstance(corrected_fields, list) or any(not isinstance(v, str) for v in corrected_fields):
        raise CorrectionError("corrected_fields must be an array of field names")
    if len(set(corrected_fields)) != len(corrected_fields):
        raise CorrectionError("corrected_fields contains duplicates")
    invalid_fields = sorted(set(corrected_fields) - set(CORRECTABLE_FIELDS))
    if invalid_fields:
        raise CorrectionError(f"Unsupported corrected fields: {invalid_fields}")

    confidence = payload["correction_confidence"]
    if isinstance(confidence, bool) or not isinstance(confidence, (int, float)):
        raise CorrectionError("correction_confidence must be numeric")
    if not 0 <= float(confidence) <= 1:
        raise CorrectionError("correction_confidence must be between 0 and 1")

    for field in CORRECTABLE_FIELDS:
        value = payload[field]
        if field in NUMERIC_FIELDS:
            if value is not None and (isinstance(value, bool) or not isinstance(value, (int, float))):
                raise CorrectionError(f"{field} must be numeric or null")
        elif value is not None and not isinstance(value, str):
            raise CorrectionError(f"{field} must be a string or null")
    unchanged_flags = [field for field in corrected_fields if payload[field] == draft[field]]
    if unchanged_flags:
        raise CorrectionError(f"Fields flagged as corrected but unchanged: {unchanged_flags}")
    return payload


def _usage_tokens(response: Any, input_text: str, output_text: str) -> tuple[int, int]:
    usage = getattr(response, "usage", None)
    input_tokens = getattr(usage, "prompt_tokens", None)
    output_tokens = getattr(usage, "completion_tokens", None)
    if input_tokens is None:
        input_tokens = max(1, len(input_text) // 4)
    if output_tokens is None:
        output_tokens = max(1, len(output_text) // 4)
    return int(input_tokens), int(output_tokens)


def _cost(input_tokens: int, output_tokens: int) -> float:
    return (
        input_tokens * INPUT_COST_PER_MILLION / 1_000_000
        + output_tokens * OUTPUT_COST_PER_MILLION / 1_000_000
    )


def _select_candidates(storage: SupabaseStorage, limit: int, threshold: float) -> list[dict[str, Any]]:
    columns = ",".join(("id", "raw_message_id", "listing_index", "confidence", *CORRECTABLE_FIELDS))
    fetch_limit = max(20, limit * 2)
    candidates: list[dict[str, Any]] = []
    seen: set[int] = set()
    clauses = [f"and(corrected_at.is.null,confidence.lt.{threshold})"]
    clauses.extend(
        f"and(corrected_at.is.null,{field}.is.null)" for field in PARTIAL_SIGNAL_FIELDS
    )

    # Separate indexed reads avoid a broad OR plus embedded join across the full table.
    for clause in clauses:
        response = (
            storage.client.table("parsed_output")
            .select(columns)
            .or_(clause)
            .order("created_at")
            .limit(fetch_limit)
            .execute()
        )
        for row in response.data:
            row_id = int(row["id"])
            if row_id not in seen and _needs_correction(row, threshold):
                candidates.append(row)
                seen.add(row_id)
                if len(candidates) >= limit:
                    break
        if len(candidates) >= limit:
            break

    raw_ids = sorted({int(row["raw_message_id"]) for row in candidates})
    if not raw_ids:
        return []
    raw_response = (
        storage.client.table("raw_messages")
        .select("id,message")
        .in_("id", raw_ids)
        .execute()
    )
    raw_by_id = {int(row["id"]): row.get("message") for row in raw_response.data}
    for row in candidates:
        row["raw_messages"] = {"message": raw_by_id.get(int(row["raw_message_id"]))}
    return candidates


def _existing_correction(
    storage: SupabaseStorage, correction_hash: str, listing_index: int
) -> dict[str, Any] | None:
    columns = ",".join((*CORRECTABLE_FIELDS, "corrected_fields", "correction_confidence"))
    response = (
        storage.client.table("parsed_output")
        .select(columns)
        .eq("correction_hash", correction_hash)
        .eq("listing_index", listing_index)
        .not_.is_("corrected_at", "null")
        .limit(1)
        .execute()
    )
    return response.data[0] if response.data else None


def _scheduled_slot(now: datetime | None = None) -> str:
    current = now or datetime.now(timezone.utc)
    return current.replace(hour=current.hour - current.hour % 2, minute=0, second=0, microsecond=0).isoformat()


def claim_scheduled_run(storage: SupabaseStorage) -> int | None:
    """Claim this two-hour window; another API worker may already own it."""
    try:
        response = storage.client.table("ai_correction_runs").insert({
            "run_slot": _scheduled_slot(),
            "trigger": "scheduled",
            "status": "running",
            "dry_run": False,
        }).execute()
    except Exception as exc:
        status_code = getattr(getattr(exc, "response", None), "status_code", None)
        if status_code == 409:
            return None
        raise
    return int(response.data[0]["id"]) if response.data else None


def finish_scheduled_run(storage: SupabaseStorage, run_id: int, summary: RunSummary) -> None:
    payload = asdict(summary)
    payload["finished_at"] = datetime.now(timezone.utc).isoformat()
    storage.client.table("ai_correction_runs").update(payload).eq("id", run_id).execute()


def _write_correction(
    storage: SupabaseStorage,
    row_id: int,
    correction_hash: str,
    payload: dict[str, Any],
) -> None:
    fields = payload["corrected_fields"]
    update = {field: payload[field] for field in fields}
    update.update({
        "correction_hash": correction_hash,
        "corrected_fields": fields,
        "correction_confidence": payload["correction_confidence"],
        "corrected_at": datetime.now(timezone.utc).isoformat(),
    })
    storage.client.table("parsed_output").update(update).eq("id", row_id).execute()


def _call_model(raw_text: str, draft: dict[str, Any]) -> tuple[dict[str, Any], int, int]:
    if not DOUBLEWORD_API_KEY:
        raise CorrectionError("DOUBLEWORD_API_KEY is not configured")
    system_prompt = _load_prompt()
    user_prompt = (
        'RAW_TEXT:\n"""\n'
        f"{raw_text}\n"
        '"""\n\nREGEX_DRAFT:\n'
        f"{json.dumps(draft, ensure_ascii=False, separators=(',', ':'))}"
    )
    client = get_client(api_key=DOUBLEWORD_API_KEY)
    timeout_seconds = float(os.getenv("AI_CORRECTION_API_TIMEOUT_SECONDS", "120"))
    response = client.with_options(timeout=timeout_seconds, max_retries=0).chat.completions.create(
        model=os.environ.get("LLM_TASK_MODEL", "default"),
        temperature=0,
        response_format={"type": "json_object"},
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
    )
    if not response.choices or not response.choices[0].message.content:
        raise CorrectionError("Doubleword returned an empty correction response")
    content = response.choices[0].message.content
    try:
        parsed = json.loads(content)
    except json.JSONDecodeError as exc:
        raise CorrectionError(f"Doubleword returned malformed JSON: {exc}") from exc
    validated = _validate_response(parsed, draft)
    input_tokens, output_tokens = _usage_tokens(response, system_prompt + user_prompt, content)
    return validated, input_tokens, output_tokens


def _write_status(summary: RunSummary, dry_run: bool) -> None:
    status = {
        **asdict(summary),
        "dry_run": dry_run,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    try:
        STATUS_PATH.parent.mkdir(parents=True, exist_ok=True)
        temp_path = STATUS_PATH.with_suffix(".tmp")
        temp_path.write_text(json.dumps(status, indent=2), encoding="utf-8")
        temp_path.replace(STATUS_PATH)
    except OSError as exc:
        logger.error("Could not write correction status file %s: %s", STATUS_PATH, exc)


def run_corrections(
    *, limit: int, dry_run: bool, threshold: float = DEFAULT_THRESHOLD,
    storage: SupabaseStorage | None = None,
) -> RunSummary:
    if limit < 1:
        raise CorrectionError("limit must be at least 1")
    if not 0 <= threshold <= 1:
        raise CorrectionError("threshold must be between 0 and 1")
    max_calls = _env_int("AI_CORRECTION_MAX_CALLS_PER_RUN", DEFAULT_MAX_CALLS)
    storage = storage or SupabaseStorage(SUPABASE_URL, SUPABASE_SERVICE_KEY)
    summary = RunSummary()
    run_cache: dict[tuple[str, int], dict[str, Any]] = {}

    try:
        logger.info("Selecting up to %s correction candidates", limit)
        candidates = _select_candidates(storage, limit, threshold)
        summary.selected_count = len(candidates)
        logger.info("Selected %s correction candidates", len(candidates))
        for index, row in enumerate(candidates, 1):
            raw = row.get("raw_messages") or {}
            raw_text = raw.get("message") if isinstance(raw, dict) else None
            if not isinstance(raw_text, str) or not raw_text.strip():
                raise CorrectionError(f"Record {row['id']} has no raw source text")
            draft = _draft(row)
            correction_hash = _raw_hash(raw_text)
            listing_index = int(row.get("listing_index") or 0)
            cache_key = (correction_hash, listing_index)
            reused = run_cache.get(cache_key)
            if reused is None:
                reused = _existing_correction(storage, correction_hash, listing_index)
            if reused:
                payload = {field: reused.get(field) for field in CORRECTABLE_FIELDS}
                payload["corrected_fields"] = [
                    field for field in (reused.get("corrected_fields") or [])
                    if reused.get(field) != draft.get(field)
                ]
                payload["correction_confidence"] = float(reused.get("correction_confidence") or 0)
                payload = _validate_response(payload, draft)
                summary.reused_count += 1
                source = "hash reuse"
            else:
                if summary.api_calls >= max_calls:
                    summary.skipped_count += len(candidates) - summary.processed_count
                    logger.warning("Correction call cap reached (%s); stopping run", max_calls)
                    break
                summary.api_calls += 1
                payload, input_tokens, output_tokens = _call_model(raw_text, draft)
                summary.input_tokens += input_tokens
                summary.output_tokens += output_tokens
                summary.estimated_cost_usd = _cost(summary.input_tokens, summary.output_tokens)
                run_cache[cache_key] = payload
                source = "Doubleword"

            changes = {field: payload[field] for field in payload["corrected_fields"]}
            print(
                f"[{index}/{len(candidates)}] parsed_output={row['id']} source={source} "
                f"confidence={payload['correction_confidence']:.2f} changes="
                f"{json.dumps(changes, ensure_ascii=False, default=str)}"
            )
            if not dry_run:
                _write_correction(storage, int(row["id"]), correction_hash, payload)
            summary.processed_count += 1
            if payload["corrected_fields"]:
                summary.corrected_count += 1
            else:
                summary.skipped_count += 1
            print(
                f"  running usage: input={summary.input_tokens} output={summary.output_tokens} "
                f"estimated_cost=${summary.estimated_cost_usd:.6f}"
            )
        summary.status = "complete"
    except Exception as exc:
        summary.status = "failed"
        summary.error = str(exc)
        raise
    finally:
        _write_status(summary, dry_run)

    print(
        "SUMMARY "
        + json.dumps({**asdict(summary), "dry_run": dry_run}, ensure_ascii=False)
    )
    return summary


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--limit", type=int, default=200)
    parser.add_argument("--threshold", type=float, default=float(os.getenv("AI_CORRECTION_CONFIDENCE_THRESHOLD", DEFAULT_THRESHOLD)))
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    try:
        run_corrections(limit=args.limit, dry_run=args.dry_run, threshold=args.threshold)
    except Exception as exc:
        logger.error("Correction run failed: %s", exc)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
