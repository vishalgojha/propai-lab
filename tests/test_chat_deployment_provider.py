import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from routers import common


def test_chat_provider_pool_uses_only_configured_doubleword(monkeypatch):
    monkeypatch.setenv("DOUBLEWORD_API_KEY", "doubleword-key")
    monkeypatch.setenv("DOUBLEWORD_MODEL", "deepseek-ai/DeepSeek-V3")
    monkeypatch.setenv("DOUBLEWORD_API_URL", "https://api.doubleword.ai/v1")
    providers = common._workspace_provider_candidates("tenant-1")

    assert providers[0]["provider"] == "doubleword"
    assert providers[0]["model"] == "deepseek-ai/DeepSeek-V3"
    assert len(providers) == 1
