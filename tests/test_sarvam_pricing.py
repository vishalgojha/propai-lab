import config


def test_sarvam_105b_uses_published_rates_converted_to_usd():
    pricing = config.get_model_pricing(model_name="sarvam-105b")

    assert pricing["input"] == 29.28 / config.SARVAM_INR_PER_USD
    assert pricing["cached_input"] == 10.98 / config.SARVAM_INR_PER_USD
    assert pricing["output"] == 73.20 / config.SARVAM_INR_PER_USD


def test_sarvam_provider_alias_resolves_same_pricing():
    assert config.get_model_pricing(provider_name="extraction-sarvam-1") == config.get_model_pricing(
        model_name="sarvam-105b"
    )
