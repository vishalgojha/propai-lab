def test_sarvam_gemma4_provider_is_opt_in(monkeypatch):
    monkeypatch.setenv("EXTRACTION_SARVAM_OPEN_SOURCE_API_KEY", "sarvam-beta-key")
    monkeypatch.delenv("EXTRACTION_SARVAM_OPEN_SOURCE_MODEL", raising=False)

    import ai_extraction
    providers = []
    ai_extraction._append_extraction_provider(
        providers,
        env_prefix="EXTRACTION_SARVAM_OPEN_SOURCE",
        name="extraction-sarvam-gemma4",
        default_base_url="https://api.sarvam.ai/v2",
        api_key_override="sarvam-beta-key",
        model_override="gemma4",
        reasoning_effort=None,
        max_tokens=8192,
    )
    provider = providers[0]

    assert provider["api_key"] == "sarvam-beta-key"
    assert provider["model"] == "gemma4"
    assert provider["base_url"] == "https://api.sarvam.ai/v2"
    assert provider["max_tokens"] == 8192
    assert ai_extraction._extraction_provider_priority(provider) == 0
