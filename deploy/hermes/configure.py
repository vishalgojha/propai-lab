"""Apply the full PropAI tool surface to the agent API-server profile."""

from pathlib import Path

import yaml


CONFIG_PATH = Path("/data/.hermes/config.yaml")
SKILL_PATH = CONFIG_PATH.parent / "skills" / "propai-ops" / "SKILL.md"
# Use Hermes' complete API-server preset. It includes the coding, terminal,
# browser/web, memory, skills, vision, delegation, code execution, scheduling,
# and session tools supported by the API deployment.
TOOLSETS = ["hermes-api-server"]
PROPAI_SKILL = """---
name: propai-ops
description: PropAI repository, data-quality, WhatsApp, Supabase, and Coolify operations.
---

Use the PropAI repository guidance injected by the API bridge. Keep work scoped to
PropAI's FastAPI/Next.js/WhatsApp/Supabase/Coolify systems and preserve source
traceability, freshness, and approval boundaries.
"""


def main() -> None:
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    config = {}
    if CONFIG_PATH.exists():
        loaded = yaml.safe_load(CONFIG_PATH.read_text())
        if isinstance(loaded, dict):
            config = loaded

    platform_toolsets = config.setdefault("platform_toolsets", {})
    # Hermes treats this list as an explicit allow-list for API-server
    # requests. The official API-server preset expands to the full supported
    # tool surface; production authorization remains an application concern.
    platform_toolsets["api_server"] = TOOLSETS

    # Keep Hermes' skills index bounded. The API bridge supplies the detailed
    # PropAI operating rules; exposing the entire bundled catalog can add
    # hundreds of thousands of prompt tokens to every request.
    skills = config.setdefault("skills", {})
    skills["include"] = ["propai-ops"]
    agent = config.setdefault("agent", {})
    agent["max_turns"] = 40
    config["tool_loop_guardrails"] = {
        "warnings_enabled": True,
        "hard_stop_enabled": True,
        "hard_stop_after": {
            "exact_failure": 2,
            "same_tool_failure": 3,
            "idempotent_no_progress": 2,
        },
        "loop_caps": {
            "max_web_searches": 10,
            "max_subagents": 4,
        },
    }
    SKILL_PATH.parent.mkdir(parents=True, exist_ok=True)
    SKILL_PATH.write_text(PROPAI_SKILL)

    CONFIG_PATH.write_text(yaml.safe_dump(config, sort_keys=False))


if __name__ == "__main__":
    main()
