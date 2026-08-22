"""Safe, dry-run Crawl4AI discovery for building identity evidence."""

from __future__ import annotations

import asyncio
import html as html_lib
import logging
import re
from dataclasses import asdict, dataclass
from typing import Iterable
from urllib.parse import parse_qs, quote, unquote, urljoin, urlparse

from .structured_extraction import extract_structured_fields

_GENERIC_DISCOVERY_WORDS = {
    "apartment", "apartments", "building", "buildings", "tower", "towers",
    "residency", "residences", "society", "complex", "heights", "view",
    "park", "garden", "enclave", "plaza", "house", "homes", "mansion",
}

logger = logging.getLogger(__name__)


@dataclass
class DiscoveryCandidate:
    building_name: str
    source_url: str
    title: str = ""
    excerpt: str = ""
    name_match: float = 0.0
    locality_match: float = 0.0
    status: str = "needs_review"
    structured_fields: dict | None = None

    def to_dict(self) -> dict:
        return asdict(self)


def _tokens(value: str) -> set[str]:
    return set(re.findall(r"[a-z0-9]+", (value or "").casefold()))


def _content_without_url_echoes(value: str) -> str:
    """Remove navigation URLs so query text cannot prove its own match."""
    value = re.sub(r"https?://[^\s)]+", " ", value or "", flags=re.IGNORECASE)
    value = re.sub(r"project_name(?:%3d|=)[^&\s)]+", " ", value, flags=re.IGNORECASE)
    return value


def rendered_page_text(result) -> str:
    """Return the richest readable text exposed by the installed Crawl4AI version."""
    parts = []
    for name in ("markdown", "fit_markdown", "raw_markdown", "cleaned_html", "fit_html", "html"):
        value = html_lib.unescape(str(getattr(result, name, "") or ""))
        if not value:
            continue
        if "html" in name:
            value = re.sub(r"<script\b[^>]*>.*?</script>|<style\b[^>]*>.*?</style>", " ", value, flags=re.IGNORECASE | re.DOTALL)
            value = re.sub(r"<[^>]+>", " ", value)
        value = re.sub(r"\s+", " ", value).strip()
        if value and value not in parts:
            parts.append(value)
    return "\n".join(parts)


def score_discovery(building_name: str, locality: str, text: str) -> tuple[float, float]:
    requested = {
        token for token in _tokens(building_name)
        if len(token) > 2 and token not in _GENERIC_DISCOVERY_WORDS
    }
    location = {token for token in _tokens(locality) if len(token) > 2}
    page = _tokens(_content_without_url_echoes(text))
    name_score = len(requested & page) / len(requested) if requested else 0.0
    locality_score = len(location & page) / len(location) if location else 0.0
    return round(name_score, 3), round(locality_score, 3)


def extract_result_urls(result, limit: int = 3) -> list[str]:
    """Return bounded external URLs exposed by a Crawl4AI result or markdown."""
    links = getattr(result, "links", None) or {}
    raw_links = []
    rendered_parts = [
        html_lib.unescape(str(getattr(result, name, "") or ""))
        for name in ("html", "cleaned_html", "fit_html")
    ]
    # Prefer actual Bing result cards over the generic link collector, which
    # also returns navigation, trending, schema and footer links. Google
    # redirect anchors are included for the same reason.
    prioritized_links = []
    for part in rendered_parts:
        prioritized_links.extend(re.findall(
            r"<li[^>]+class=[\"'][^\"']*b_algo[^\"']*[\"'][^>]*>.*?<a[^>]+href=[\"']([^\"']+)",
            part, flags=re.IGNORECASE | re.DOTALL,
        ))
        prioritized_links.extend(re.findall(
            r"<h2[^>]*>\s*<a[^>]+href=[\"']([^\"']+)",
            part, flags=re.IGNORECASE | re.DOTALL,
        ))
        prioritized_links.extend(re.findall(
            r"<a[^>]+href=[\"']((?:/url\?|https?://www\.google\.com/url\?)[^\"']+)",
            part, flags=re.IGNORECASE,
        ))
    raw_links.extend(prioritized_links)
    if isinstance(links, dict):
        for value in links.values():
            raw_links.extend(value if isinstance(value, list) else [value])
    elif isinstance(links, list):
        raw_links.extend(links)

    # Crawl4AI versions/configurations expose different representations of a
    # rendered page. Google result anchors may be absent from ``links`` and
    # ``markdown`` but still present in cleaned/fit HTML.
    rendered_parts.extend(
        html_lib.unescape(str(getattr(result, name, "") or ""))
        for name in ("markdown", "fit_markdown", "raw_markdown")
    )
    for part in rendered_parts:
        rendered = html_lib.unescape(part)
        raw_links.extend(re.findall(r"https?://[^\s)\]>\"']+", rendered, flags=re.IGNORECASE))
        raw_links.extend(re.findall(r"(?:href|data-href)=[\"']([^\"']+)", rendered, flags=re.IGNORECASE))
        raw_links.extend(re.findall(r"https?://[^\s<>\"']+", rendered, flags=re.IGNORECASE))

    urls: list[str] = []
    seen: set[str] = set()
    blocked_hosts = {
        "google.com", "www.google.com", "accounts.google.com", "support.google.com",
        "bing.com", "www.bing.com",
        # Search pages expose XML/HTML namespace links through Crawl4AI's
        # generic link collector. They are not result pages and must not
        # consume the bounded external-result budget.
        "w3.org", "www.w3.org", "schemas.live.com", "schema.org", "www.schema.org",
    }
    for item in raw_links:
        url = item.get("href") or item.get("url") if isinstance(item, dict) else item
        if not isinstance(url, str):
            continue
        url = html_lib.unescape(url.strip())
        # Crawl4AI can expose citation markup as part of an anchor value,
        # e.g. ``https://example.com</cite>``. Keep only the URL token before
        # validating and crawling it.
        url = re.split(r"[\s<>\"']", url, maxsplit=1)[0].rstrip(").,;'")
        # Google result anchors are frequently relative links such as
        # /url?q=https%3A%2F%2Fexample.com. Resolve them against Google before
        # applying the source-host safety checks below.
        if url.startswith(("/", "//")):
            url = urljoin("https://www.google.com", url)
        if not url.startswith(("http://", "https://")):
            continue
        parsed = urlparse(url)
        host = parsed.netloc.casefold().split(":", 1)[0]
        if host.endswith(".google.com"):
            redirected = None
            if parsed.path == "/url":
                query = parse_qs(parsed.query)
                redirected = query.get("q") or query.get("url")
            url = unquote(redirected[0]) if redirected and redirected[0].startswith(("http://", "https://")) else ""
            parsed = urlparse(url)
            host = parsed.netloc.casefold().split(":", 1)[0]
        if not url or host in blocked_hosts or host.endswith((".google.com", ".bing.com")) or url in seen:
            continue
        seen.add(url)
        urls.append(url)
        if len(urls) >= max(1, limit):
            break
    return urls


async def crawl_discovery_pages(
    building_names: Iterable[str],
    url_templates: Iterable[str],
    localities: dict[str, str] | None = None,
) -> list[DiscoveryCandidate]:
    """Crawl explicitly configured sources; never write to Supabase."""
    try:
        from crawl4ai import AsyncWebCrawler, CacheMode, CrawlerRunConfig
    except ImportError as exc:
        raise RuntimeError(
            "Crawl4AI is not installed. Install with: pip install -r requirements.discovery.txt"
        ) from exc

    names = [name.strip() for name in building_names if name and name.strip()]
    templates = [template.strip() for template in url_templates if template and template.strip()]
    localities = localities or {}
    candidates: list[DiscoveryCandidate] = []
    max_result_pages = 3

    async with AsyncWebCrawler() as crawler:
        config = CrawlerRunConfig(cache_mode=CacheMode.BYPASS)
        for name in names:
            locality = localities.get(name, "")
            for template_index, template in enumerate(templates):
                url = template.format(query=quote(name), locality=quote(locality))
                result = await crawler.arun(url=url, config=config)
                if not result.success:
                    candidates.append(DiscoveryCandidate(
                        building_name=name, source_url=url,
                        excerpt=f"crawl failed: {result.error_message or 'unknown error'}",
                    ))
                    continue
                pages = [(url, result)]
                linked_urls = extract_result_urls(result, limit=max_result_pages)
                logger.info(
                    "Crawl4AI discovery %s via template %d: external_links=%d text_chars=%d",
                    name, template_index + 1, len(linked_urls), len(rendered_page_text(result)),
                )
                # Search providers can return a successful HTML response with
                # no outbound anchors. Try the next configured provider only
                # in that case; once one provider exposes links, avoid extra
                # searches and unnecessary quota usage.
                if not linked_urls and template_index < len(templates) - 1:
                    continue
                for linked_url in linked_urls:
                    linked_result = await crawler.arun(url=linked_url, config=config)
                    if linked_result.success:
                        pages.append((linked_url, linked_result))
                for page_url, page_result in pages:
                    markdown = rendered_page_text(page_result)
                    metadata = getattr(page_result, "metadata", None) or {}
                    title = metadata.get("title", "") or getattr(page_result, "title", "") or ""
                    excerpt = " ".join(markdown.split())[:1200]
                    name_score, locality_score = score_discovery(name, locality, f"{title} {markdown}")
                    candidates.append(DiscoveryCandidate(
                        building_name=name, source_url=page_url, title=title, excerpt=excerpt,
                        name_match=name_score, locality_match=locality_score,
                        status="candidate" if name_score >= 0.75 else "needs_review",
                        structured_fields=extract_structured_fields(title, markdown),
                    ))
                if linked_urls:
                    break
    return candidates


def crawl_discovery_pages_sync(*args, **kwargs) -> list[DiscoveryCandidate]:
    return asyncio.run(crawl_discovery_pages(*args, **kwargs))
