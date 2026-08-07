"""Tenant-scoped agent-browser runtime for AI browser actions."""

from __future__ import annotations

from dataclasses import dataclass, field
import json
import os
import shutil
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Any


AGENT_BROWSER_INSTALL_MESSAGE = (
    "agent-browser CLI is not installed. Install with: "
    "npm install -g agent-browser && agent-browser install"
)


@dataclass
class BrowserActionResult:
    status: str
    browser_session_id: str
    provider: str
    command: str
    url: str = ""
    title: str = ""
    summary: str = ""
    elements: list[dict[str, Any]] = field(default_factory=list)
    screenshot_path: str = ""
    raw_output: str = ""
    error: str = ""


class BrowserRuntimeError(RuntimeError):
    pass


class _BaseBrowserProvider:
    provider_name = "unknown"

    def health_check(self) -> dict[str, str | bool]:
        raise NotImplementedError

    def open(self, session_name: str, url: str) -> BrowserActionResult:
        raise NotImplementedError

    def state(self, session_name: str) -> BrowserActionResult:
        raise NotImplementedError

    def click(self, session_name: str, index: int) -> BrowserActionResult:
        raise NotImplementedError

    def fill(self, session_name: str, index: int, text: str) -> BrowserActionResult:
        raise NotImplementedError

    def type(self, session_name: str, text: str) -> BrowserActionResult:
        raise NotImplementedError

    def select(self, session_name: str, index: int, value: str) -> BrowserActionResult:
        raise NotImplementedError

    def scroll(self, session_name: str, amount: int) -> BrowserActionResult:
        raise NotImplementedError

    def screenshot(self, session_name: str, output_path: str | None = None) -> BrowserActionResult:
        raise NotImplementedError

    def close(self, session_name: str) -> BrowserActionResult:
        raise NotImplementedError


class _AgentBrowserProvider(_BaseBrowserProvider):
    provider_name = "agent-browser"

    def __init__(self) -> None:
        self._binary = os.getenv("AGENT_BROWSER_BIN") or shutil.which("agent-browser") or ""

    def health_check(self) -> dict[str, str | bool]:
        if not self._binary or not shutil.which(self._binary) and not Path(self._binary).exists():
            return {"ok": False, "error": AGENT_BROWSER_INSTALL_MESSAGE}
        try:
            result = subprocess.run(
                [self._binary, "--version"], capture_output=True, text=True, timeout=10, check=False
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            return {"ok": False, "error": f"agent-browser CLI could not start: {exc}"}
        if result.returncode != 0:
            return {"ok": False, "error": (result.stderr or result.stdout or "agent-browser --version failed").strip()}
        return {"ok": True, "binary": self._binary, "version": (result.stdout or result.stderr).strip()}

    def _run(self, session_name: str, *args: str) -> BrowserActionResult:
        health = self.health_check()
        command = [self._binary, "--session", session_name, *args]
        if not health.get("ok"):
            return BrowserActionResult(
                status="error", browser_session_id=session_name, provider=self.provider_name,
                command=" ".join(command), error=str(health.get("error") or AGENT_BROWSER_INSTALL_MESSAGE),
            )
        try:
            timeout = int(os.getenv("AGENT_BROWSER_TIMEOUT", "300"))
        except ValueError:
            timeout = 300
        try:
            proc = subprocess.run(command, capture_output=True, text=True, timeout=timeout, check=False)
        except subprocess.TimeoutExpired:
            return BrowserActionResult(
                status="error", browser_session_id=session_name, provider=self.provider_name,
                command=" ".join(command), error=f"agent-browser timed out after {timeout} seconds",
            )
        except OSError as exc:
            return BrowserActionResult(
                status="error", browser_session_id=session_name, provider=self.provider_name,
                command=" ".join(command), error=str(exc),
            )
        raw = (proc.stdout or "").strip()
        err = (proc.stderr or "").strip()
        return BrowserActionResult(
            status="ok" if proc.returncode == 0 else "error",
            browser_session_id=session_name,
            provider=self.provider_name,
            command=" ".join(command),
            raw_output=raw or err,
            error=err if proc.returncode != 0 else "",
            summary=raw.splitlines()[0] if raw else "",
        )

    def open(self, session_name: str, url: str) -> BrowserActionResult:
        return self._run(session_name, "open", url)

    def state(self, session_name: str) -> BrowserActionResult:
        result = self._run(session_name, "snapshot", "--json")
        if result.status == "ok":
            result.elements, result.url, result.title = _parse_agent_browser_snapshot(result.raw_output)
        return result

    def click(self, session_name: str, index: int) -> BrowserActionResult:
        return self._run(session_name, "click", f"@e{int(index)}")

    def fill(self, session_name: str, index: int, text: str) -> BrowserActionResult:
        return self._run(session_name, "fill", f"@e{int(index)}", text)

    def type(self, session_name: str, text: str) -> BrowserActionResult:
        return self._run(session_name, "keyboard", "type", text)

    def select(self, session_name: str, index: int, value: str) -> BrowserActionResult:
        return self._run(session_name, "select", f"@e{int(index)}", value)

    def scroll(self, session_name: str, amount: int) -> BrowserActionResult:
        direction = "down" if amount >= 0 else "up"
        return self._run(session_name, "scroll", direction, str(abs(int(amount))))

    def screenshot(self, session_name: str, output_path: str | None = None) -> BrowserActionResult:
        if output_path is None:
            out_dir = Path(tempfile.gettempdir()) / "propai-browser"
            out_dir.mkdir(parents=True, exist_ok=True)
            output_path = str(out_dir / f"{session_name}-{int(time.time())}.png")
        result = self._run(session_name, "screenshot", output_path)
        result.screenshot_path = output_path
        return result

    def close(self, session_name: str) -> BrowserActionResult:
        return self._run(session_name, "close")


def _snapshot_payload(raw_output: str) -> Any:
    try:
        return json.loads(raw_output)
    except json.JSONDecodeError:
        return None


def _parse_agent_browser_snapshot(raw_output: str) -> tuple[list[dict[str, Any]], str, str]:
    """Parse agent-browser's JSON accessibility snapshot and preserve @eN refs."""
    payload = _snapshot_payload(raw_output)
    if payload is None:
        return [], "", ""
    metadata = payload if isinstance(payload, dict) else {}
    for key in ("data", "snapshot", "page"):
        if isinstance(metadata.get(key), dict):
            metadata = {**metadata, **metadata[key]}
    nodes = payload if isinstance(payload, list) else metadata.get("nodes") or metadata.get("elements") or []
    refs = metadata.get("refs") or {}
    if not nodes and isinstance(refs, dict):
        nodes = [{"ref": f"@{ref}", **(value if isinstance(value, dict) else {})} for ref, value in refs.items()]
    elements: list[dict[str, Any]] = []
    for node in nodes if isinstance(nodes, list) else []:
        if not isinstance(node, dict):
            continue
        ref = str(node.get("ref") or node.get("id") or "")
        if not ref.startswith("@e"):
            continue
        try:
            index = int(ref[2:])
        except ValueError:
            continue
        kind = str(node.get("role") or node.get("kind") or node.get("type") or "element")
        text = str(node.get("name") or node.get("text") or node.get("value") or "").strip()
        elements.append({"index": index, "kind": kind, "text": text, "raw": f"{ref} {kind} '{text}'"})
    url = str(metadata.get("url") or metadata.get("currentUrl") or "")
    title = str(metadata.get("title") or "")
    return elements, url, title


class BrowserRuntimeManager:
    def __init__(self) -> None:
        self._provider: _BaseBrowserProvider | None = None

    def _provider_impl(self) -> _BaseBrowserProvider:
        if self._provider is None:
            self._provider = _AgentBrowserProvider()
        return self._provider

    def health_check(self) -> dict[str, str | bool]:
        return self._provider_impl().health_check()

    def run(self, provider_name: str | None, command: str, session_name: str, **kwargs) -> BrowserActionResult:
        normalized = str(provider_name or "agent-browser").strip().lower()
        if normalized not in {"agent-browser", "browser-use", "browser-use-cli", "browser_use", "playwright"}:
            raise BrowserRuntimeError(f"Unsupported browser provider: {provider_name}")
        provider = self._provider_impl()
        if command == "open": return provider.open(session_name, str(kwargs.get("url") or ""))
        if command == "state": return provider.state(session_name)
        if command == "click": return provider.click(session_name, int(kwargs.get("index") or 0))
        if command == "fill": return provider.fill(session_name, int(kwargs.get("index") or 0), str(kwargs.get("text") or ""))
        if command == "type": return provider.type(session_name, str(kwargs.get("text") or ""))
        if command == "select": return provider.select(session_name, int(kwargs.get("index") or 0), str(kwargs.get("value") or ""))
        if command == "scroll": return provider.scroll(session_name, int(kwargs.get("amount") or 0))
        if command == "screenshot": return provider.screenshot(session_name, kwargs.get("output_path") or None)
        if command == "close": return provider.close(session_name)
        raise BrowserRuntimeError(f"Unknown browser runtime command: {command}")


_RUNTIME = BrowserRuntimeManager()


def run_browser_command(provider_name: str | None, command: str, session_name: str, **kwargs) -> BrowserActionResult:
    return _RUNTIME.run(provider_name, command, session_name, **kwargs)
