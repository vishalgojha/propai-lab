"""Apply PropAI's API tool policy to the Hermes profile."""

import os
from pathlib import Path

import yaml


CONFIG_PATH = Path("/data/.hermes/config.yaml")
SKILL_PATH = CONFIG_PATH.parent / "skills" / "propai-ops" / "SKILL.md"
# The complete API preset registers every optional schema on every request.
# Keep the normal agent broad without paying that prompt cost. Set
# PROPAI_AGENT_FULL_TOOLS=true for the unfiltered Hermes preset.
COMPACT_TOOLSETS = ["propai-coding"]
FULL_TOOLSETS = ["hermes-api-server"]
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

    custom_toolsets = config.setdefault("custom_toolsets", {})
    custom_toolsets["propai-coding"] = [
        "file",
        "terminal",
        "search",
        "web",
        "browser",
        "memory",
        "session_search",
        "todo",
        "code_execution",
        "delegation",
        "vision",
    ]

    platform_toolsets = config.setdefault("platform_toolsets", {})
    platform_toolsets["api_server"] = (
        FULL_TOOLSETS
        if os.getenv("PROPAI_AGENT_FULL_TOOLS", "").strip().lower()
        in {"1", "true", "yes", "on"}
        else COMPACT_TOOLSETS
    )

    # The compact profile omits the skills toolset, so Hermes does not inject
    # the complete installed-skills catalogue into every request.
    skills = config.setdefault("skills", {})
    skills.pop("include", None)
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
