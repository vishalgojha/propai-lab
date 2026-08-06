"""Tenant-scoped browser-use runtime for agent actions.

This runtime is intentionally thin: it exposes a small set of agent-facing
actions, persists browser sessions through Supabase-backed tables, and shells
out to the Browser Use CLI.
"""

from __future__ import annotations

from dataclasses import dataclass, field
import json
import os
import re
import shutil
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Any


_STATE_INDEX_RE = re.compile(r"^\[(\d+)\]\s+(\w+)\s+(.+)$")


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


class _BrowserUseCliProvider(_BaseBrowserProvider):
    provider_name = "browser-use"

    def __init__(self) -> None:
        self._binary = os.getenv("BROWSER_USE_BIN") or shutil.which("browser-use") or "browser-use"

    def _run(self, session_name: str, *args: str, timeout: int = 120) -> BrowserActionResult:
        cmd = [self._binary, "--session", session_name, *args]
        started = time.time()
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
        raw = (proc.stdout or "").strip()
        err = (proc.stderr or "").strip()
        status = "ok" if proc.returncode == 0 else "error"
        return BrowserActionResult(
            status=status,
            browser_session_id=session_name,
            provider=self.provider_name,
            command=" ".join(cmd),
            raw_output=raw or err,
            error=err if proc.returncode != 0 else "",
            summary=raw.splitlines()[0] if raw else "",
        )

    def open(self, session_name: str, url: str) -> BrowserActionResult:
        return self._run(session_name, "open", url)

    def state(self, session_name: str) -> BrowserActionResult:
        result = self._run(session_name, "state")
        result.elements = _parse_browser_use_state(result.raw_output)
        result.url = _extract_browser_use_field(result.raw_output, "URL") or ""
        result.title = _extract_browser_use_field(result.raw_output, "Title") or ""
        return result

    def click(self, session_name: str, index: int) -> BrowserActionResult:
        return self._run(session_name, "click", str(int(index)))

    def fill(self, session_name: str, index: int, text: str) -> BrowserActionResult:
        return self._run(session_name, "input", str(int(index)), text)

    def type(self, session_name: str, text: str) -> BrowserActionResult:
        return self._run(session_name, "type", text)

    def select(self, session_name: str, index: int, value: str) -> BrowserActionResult:
        return self._run(session_name, "select", str(int(index)), value)

    def scroll(self, session_name: str, amount: int) -> BrowserActionResult:
        direction = "down" if amount >= 0 else "up"
        return self._run(session_name, "scroll", direction, "--amount", str(abs(int(amount))))

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


def _extract_browser_use_field(raw_output: str, label: str) -> str:
    pattern = re.compile(rf"^{re.escape(label)}:\s*(.+)$", re.IGNORECASE | re.MULTILINE)
    match = pattern.search(raw_output or "")
    return match.group(1).strip() if match else ""


def _parse_browser_use_state(raw_output: str) -> list[dict[str, Any]]:
    elements: list[dict[str, Any]] = []
    for line in (raw_output or "").splitlines():
        match = _STATE_INDEX_RE.match(line.strip())
        if not match:
            continue
        index = int(match.group(1))
        kind = match.group(2).strip()
        rest = match.group(3).strip()
        text = rest
        if rest.startswith('"') and rest.count('"') >= 2:
            parts = rest.split('"')
            text = parts[1]
        elements.append({
            "index": index,
            "kind": kind,
            "text": text,
            "raw": line.strip(),
        })
    return elements


def _collect_interactables(page: Any) -> list[dict[str, Any]]:
    items = page.evaluate(
        """
        () => Array.from(document.querySelectorAll('button, a, input, textarea, select, [role="button"], [onclick]'))
          .map((el, index) => ({
            index,
            tag: el.tagName.toLowerCase(),
            text: (el.innerText || el.textContent || el.value || '').trim().replace(/\\s+/g, ' ').slice(0, 200),
            aria_label: el.getAttribute('aria-label') || '',
            placeholder: el.getAttribute('placeholder') || '',
            href: el.getAttribute('href') || '',
            type: el.getAttribute('type') || '',
          }))
        """
    )
    return list(items or [])


def _indexed_locator(page: Any, index: int):
    return page.locator('button, a, input, textarea, select, [role="button"], [onclick]').nth(int(index))


class BrowserRuntimeManager:
    def __init__(self) -> None:
        self._provider: _BaseBrowserProvider | None = None

    def _provider_impl(self) -> _BaseBrowserProvider:
        if self._provider is None:
            self._provider = _BrowserUseCliProvider()
        return self._provider

    def run(self, provider_name: str | None, command: str, session_name: str, **kwargs) -> BrowserActionResult:
        if provider_name and provider_name.strip().lower() not in {"browser-use", "browser-use-cli", "playwright"}:
            raise BrowserRuntimeError(f"Unsupported browser provider: {provider_name}")
        provider = self._provider_impl()
        if command == "open":
            return provider.open(session_name, str(kwargs.get("url") or ""))
        if command == "state":
            return provider.state(session_name)
        if command == "click":
            return provider.click(session_name, int(kwargs.get("index") or 0))
        if command == "fill":
            return provider.fill(session_name, int(kwargs.get("index") or 0), str(kwargs.get("text") or ""))
        if command == "type":
            return provider.type(session_name, str(kwargs.get("text") or ""))
        if command == "select":
            return provider.select(session_name, int(kwargs.get("index") or 0), str(kwargs.get("value") or ""))
        if command == "scroll":
            return provider.scroll(session_name, int(kwargs.get("amount") or 0))
        if command == "screenshot":
            return provider.screenshot(session_name, kwargs.get("output_path") or None)
        if command == "close":
            return provider.close(session_name)
        raise BrowserRuntimeError(f"Unknown browser runtime command: {command}")


_RUNTIME = BrowserRuntimeManager()


def run_browser_command(provider_name: str | None, command: str, session_name: str, **kwargs) -> BrowserActionResult:
    """Execute a browser action through the configured runtime provider."""
    return _RUNTIME.run(provider_name, command, session_name, **kwargs)
