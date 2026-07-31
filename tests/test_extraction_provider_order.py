"""Unit tests for cheap-first extraction provider ordering.

Extraction deliberately prefers small, fast models over premium ones
(Grid/merge) to cut cost, keeping premium models only as an escalation
fallback.  These tests pin the ordering contract.
"""

from config import get_model_pricing
import ai_extraction


def _provider(name, model):
    return {"name": name, "provider": name, "api_key": "k", "base_url": "http://x", "model": model}


CHEAP = _provider("groq", "llama-3.1-8b-instant")
CHEAP2 = _provider("nvidia", "meta/llama-3.1-8b-instruct")
GEMINI = _provider("gemini", "gemini-3.1-flash-lite")
PREMIUM = _provider("grid", "code-max")
PREMIUM2 = _provider("merge", "claude-haiku-4-5")

CHAIN = [PREMIUM, CHEAP, PREMIUM2, CHEAP2, GEMINI]


def test_default_ordering_is_cheap_first_premium_last(monkeypatch):
    monkeypatch.setattr(ai_extraction, "_EXTRACTION_MODEL", "")

    ordered = sorted(CHAIN, key=ai_extraction._extraction_provider_priority)

    names = [p["name"] for p in ordered]
    assert names == ["groq", "nvidia", "gemini", "grid", "merge"]


def test_pinned_model_goes_first_others_keep_tiers(monkeypatch):
    monkeypatch.setattr(ai_extraction, "_EXTRACTION_MODEL", "llama-3.1-8b-instant")

    ordered = sorted(CHAIN, key=ai_extraction._extraction_provider_priority)

    assert ordered[0]["name"] == "groq"
    names = [p["name"] for p in ordered]
    # premium (grid/merge) still last, in original order
    assert names[-2:] == ["grid", "merge"]


def test_sort_is_stable_within_tier(monkeypatch):
    monkeypatch.setattr(ai_extraction, "_EXTRACTION_MODEL", "")

    tier0 = [p for p in sorted(CHAIN, key=ai_extraction._extraction_provider_priority)
             if ai_extraction._extraction_provider_priority(p) == 0]

    # non-premium providers keep their original chain order
    assert [p["name"] for p in tier0] == ["groq", "nvidia", "gemini"]


def test_gemini_flash_is_not_treated_as_premium(monkeypatch):
    monkeypatch.setattr(ai_extraction, "_EXTRACTION_MODEL", "")
    assert ai_extraction._extraction_provider_priority(GEMINI) == 0


def test_premium_models_always_tier_two(monkeypatch):
    monkeypatch.setattr(ai_extraction, "_EXTRACTION_MODEL", "")
    for p in (PREMIUM, PREMIUM2):
        assert ai_extraction._extraction_provider_priority(p) == 2


def test_get_model_pricing_matches_numbered_provider_variants():
    assert get_model_pricing(provider_name="grid")["input"] == 1.40
    assert get_model_pricing(provider_name="grid_1")["input"] == 1.40
    assert get_model_pricing(provider_name="nvidia_2")["input"] == 0.20


def test_get_model_pricing_has_groq():
    assert get_model_pricing(provider_name="groq")["input"] == 0.05


def test_get_model_pricing_unknown_provider_uses_default():
    assert get_model_pricing(provider_name="some-unknown")["input"] == 0.20
