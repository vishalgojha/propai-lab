"""Apply the bounded PropAI tool surface to Hermes' API-server profile."""

from pathlib import Path

import yaml


CONFIG_PATH = Path("/data/.hermes/config.yaml")
TOOLSETS = ["file", "terminal", "web", "session_search", "todo"]


def main() -> None:
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    config = {}
    if CONFIG_PATH.exists():
        loaded = yaml.safe_load(CONFIG_PATH.read_text())
        if isinstance(loaded, dict):
            config = loaded

    platform_toolsets = config.setdefault("platform_toolsets", {})
    # Hermes treats this list as an explicit allow-list for API-server
    # requests. Keep it direct: custom toolset aliases are not expanded
    # consistently by the API-server resolver.
    platform_toolsets["api_server"] = TOOLSETS

    CONFIG_PATH.write_text(yaml.safe_dump(config, sort_keys=False))


if __name__ == "__main__":
    main()
