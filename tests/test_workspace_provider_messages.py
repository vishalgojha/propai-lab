from services.provider_messages import prepare_messages


def test_sarvam_receives_plain_string_messages():
    messages = [
        {"role": "system", "content": "You are PropAI."},
        {"role": "user", "content": "Where is Rustomjee Paramount?"},
    ]

    prepared = prepare_messages(messages, "https://api.sarvam.ai/v1")

    assert prepared == messages
    assert all(isinstance(message["content"], str) for message in prepared)


def test_other_providers_keep_prompt_cache_blocks():
    prepared = prepare_messages(
        [{"role": "system", "content": "You are PropAI."}],
        "https://api.doubleword.ai/v1",
    )

    assert prepared[0]["content"][0]["text"] == "You are PropAI."
    assert prepared[0]["content"][0]["cache_control"]
