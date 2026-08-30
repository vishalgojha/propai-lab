from dataclasses import dataclass

from extraction_reprocessing_worker import RateLimiter, recoverable_source


@dataclass
class Raw:
    message: str = ""
    raw_payload: object = None


def test_recoverable_source_rejects_media_only_rows():
    assert recoverable_source(Raw(message="[Image]")) == ""
    assert recoverable_source(Raw(message="", raw_payload={"slice_text": "[Video]"})) == ""


def test_recoverable_source_prefers_raw_message_and_uses_legacy_payload():
    assert recoverable_source(Raw(message="2 BHK in Bandra", raw_payload={"full_text": "wrong"})) == "2 BHK in Bandra"
    assert recoverable_source(Raw(message="", raw_payload={"slice_text": "Location: Khar"})) == "Location: Khar"


def test_rate_limiter_disabled_is_non_blocking():
    RateLimiter(0).wait()
