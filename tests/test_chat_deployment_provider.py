import sys
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from routers import common


def test_chat_provider_pool_prefers_configured_doubleword(monkeypatch):
    monkeypatch.setenv("DOUBLEWORD_API_KEY", "doubleword-key")
    monkeypatch.setenv("DOUBLEWORD_MODEL", "deepseek-ai/DeepSeek-V3")
    monkeypatch.setenv("DOUBLEWORD_API_URL", "https://api.doubleword.ai/v1")
    monkeypatch.setattr(common.storage, "_real", SimpleNamespace(
        get_llm_providers=lambda tenant_id: [
            {
                "provider_name": "free-workspace-route",
                "provider_type": "openrouter",
                "api_key": "workspace-key",
                "base_url": "https://openrouter.ai/api/v1",
                "model_name": "free-model",
                "is_active": 1,
            }
        ],
    ))

    providers = common._workspace_provider_candidates("tenant-1")

    assert providers[0]["provider"] == "doubleword"
    assert providers[0]["model"] == "deepseek-ai/DeepSeek-V3"
    assert providers[1]["provider"] == "free-workspace-route"
