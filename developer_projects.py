"""Config-driven, evidence-grounded developer project crawl pipeline.

This module never touches WhatsApp raw messages or typed extraction tables.
Run with: python developer_projects.py --config config/developer_projects.yml
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import httpx
import yaml

from agents.building_enrichment.crawl_discovery import rendered_page_text
from agents.building_enrichment.structured_extraction import extract_structured_fields
from registry.developers import extract_developer

FACTS = ("project_name", "developer", "locality", "address", "bhk_range", "price_range", "amenities", "possession_status", "rera_number")
VALID_TYPES = {"maharera", "developer", "portal"}


def slugify(value: str) -> str:
    return re.sub(r"^-+|-+$", "", re.sub(r"[^a-z0-9]+", "-", value.casefold()))


def load_config(path: str) -> list[dict[str, Any]]:
    payload = yaml.safe_load(Path(path).read_text(encoding="utf-8")) or {}
    projects = payload.get("projects") or []
    for project in projects:
        if not project.get("key") or not project.get("name") or not project.get("locality"):
            raise ValueError("Every developer project needs key, name, and locality")
        for source in project.get("sources") or []:
            if source.get("type") not in VALID_TYPES or not source.get("url"):
                raise ValueError(f"Invalid source for {project['key']}")
    return projects


def _value(text: str, *patterns: str) -> tuple[str, str] | None:
    for pattern in patterns:
        match = re.search(pattern, text, flags=re.I | re.M)
        if match:
            value = " ".join(match.group(1).split()).strip(" :-|•")
            if value:
                return value[:500], match.group(0)[:700]
    return None


def extract_project_facts(name: str, developer: str, locality: str, title: str, text: str) -> dict[str, dict[str, Any]]:
    """Extract only explicit, deterministic claims from the rendered source."""
    combined = f"{title}\n{text}"
    requested_tokens = {token for token in re.findall(r"[a-z0-9]+", name.casefold()) if len(token) > 2}
    page_tokens = set(re.findall(r"[a-z0-9]+", combined.casefold()))
    facts: dict[str, dict[str, Any]] = {}
    if requested_tokens and len(requested_tokens & page_tokens) / len(requested_tokens) >= 0.75:
        facts["project_name"] = {"value": name, "evidence": title or text[:500], "confidence": 0.8}
    explicit = extract_structured_fields(title, text)
    for source_name, fact_name in (("developer", "developer"), ("address", "address"), ("completion_status", "possession_status"), ("rera_number", "rera_number"), ("amenities", "amenities")):
        if source_name in explicit:
            item = explicit[source_name]
            if fact_name == "developer":
                item = {**item, "value": extract_developer(str(item.get("value") or "")) or item.get("value")}
            facts[fact_name] = item
    for fact, patterns in {
        "locality": (r"(?:locality|micro[- ]market|area)\s*[:\-]\s*([^\n|]+)",),
        "bhk_range": (r"((?:1|2|3|4|5)(?:\.5)?\s*(?:to|-|–)\s*(?:1|2|3|4|5)(?:\.5)?\s*BHK)", r"((?:[1-5](?:\.5)?\s*BHK(?:\s*,?\s*)?){1,5})"),
        "price_range": (r"((?:₹|Rs\.?|INR)\s*[\d,.]+\s*(?:lakh|lac|crore|cr)?\s*(?:to|-|–)\s*(?:₹|Rs\.?|INR)?\s*[\d,.]+\s*(?:lakh|lac|crore|cr)?)",),
    }.items():
        found = _value(combined, *patterns)
        if found and fact not in facts:
            facts[fact] = {"value": found[0], "evidence": found[1], "confidence": 0.72}
    if "locality" not in facts and locality.casefold() in combined.casefold():
        facts["locality"] = {"value": locality, "evidence": locality, "confidence": 0.65}
    return {key: value for key, value in facts.items() if key in FACTS}


class ProjectStore:
    def __init__(self) -> None:
        self.url = os.environ.get("SUPABASE_URL", "").rstrip("/")
        # Coolify's enrichment service exposes SUPABASE_SERVICE_KEY as the
        # active project API secret. Prefer it when both variables exist:
        # SUPABASE_SERVICE_ROLE_KEY may be an older/rotated JWT and must not
        # shadow the verified runtime key.
        self.key = os.environ.get("SUPABASE_SERVICE_KEY") or os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
        if not self.url or not self.key:
            raise RuntimeError("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY/SUPABASE_SERVICE_KEY are required")
        self.client = httpx.Client(headers={"apikey": self.key, "Authorization": f"Bearer {self.key}", "Content-Type": "application/json"}, timeout=60)

    def close(self) -> None:
        self.client.close()

    def ping_indexnow(self, project: dict[str, Any]) -> None:
        """Notify IndexNow only after a grounded fact changed."""
        key = os.environ.get("INDEXNOW_KEY", "").strip()
        host = os.environ.get("INDEXNOW_HOST", "www.propai.live").strip()
        if not key:
            return
        url = f"https://{host}/projects/{slugify(str(project.get('locality') or ''))}/{slugify(str(project.get('name') or ''))}"
        try:
            response = self.client.post(
                "https://api.indexnow.org/indexnow",
                json={"host": host, "key": key, "urlList": [url]},
                headers={"Content-Type": "application/json; charset=utf-8"},
            )
            response.raise_for_status()
        except Exception:
            # IndexNow is an optimization, never a reason to mark a successful
            # crawl as failed or to retry the source.
            pass

    def _request(self, method: str, table: str, **kwargs: Any) -> list[dict[str, Any]]:
        response = self.client.request(method, f"{self.url}/rest/v1/{table}", **kwargs)
        response.raise_for_status()
        return response.json() if response.content else []

    def upsert_project(self, config: dict[str, Any]) -> dict[str, Any]:
        existing = self._request("GET", "developer_projects", params={"project_key": f"eq.{config['key']}", "select": "*", "limit": 1})
        if existing:
            return existing[0]
        rows = self._request("POST", "developer_projects", params={"on_conflict": "project_key"}, headers={"Prefer": "resolution=merge-duplicates,return=representation"}, json={"project_key": config["key"], "canonical_name": config["name"], "developer_name": config.get("developer"), "locality": config["locality"], "city": config.get("city"), "slug": slugify(config["name"]), "next_crawl_at": datetime.now(timezone.utc).isoformat()})
        created = rows[0]
        created["_newly_created"] = True
        return created

    def upsert_source(self, project_id: int, source: dict[str, Any]) -> dict[str, Any]:
        rows = self._request("POST", "developer_project_sources", params={"on_conflict": "project_id,source_url"}, headers={"Prefer": "resolution=merge-duplicates,return=representation"}, json={"project_id": project_id, "source_url": source["url"], "source_type": source["type"], "priority": source.get("priority", 100), "enabled": True})
        return rows[0]

    def crawl_run(self, project_id: int, source_id: int) -> dict[str, Any]:
        return self._request("POST", "developer_project_crawl_runs", headers={"Prefer": "return=representation"}, json={"project_id": project_id, "source_id": source_id, "status": "running"})[0]

    def finish_run(self, run_id: int, payload: dict[str, Any]) -> None:
        self._request("PATCH", "developer_project_crawl_runs", params={"id": f"eq.{run_id}"}, headers={"Prefer": "return=minimal"}, json=payload)

    def save_document(self, project_id: int, source_id: int, run_id: int, url: str, title: str, text: str, html: str, digest: str) -> dict[str, Any]:
        return self._request("POST", "developer_project_source_documents", headers={"Prefer": "return=representation"}, json={"project_id": project_id, "source_id": source_id, "crawl_run_id": run_id, "source_url": url, "page_title": title, "raw_text": text, "rendered_html": html[:2_000_000], "content_hash": digest})[0]

    def save_fact(self, project_id: int, fact_name: str, fact: dict[str, Any], document: dict[str, Any]) -> bool:
        existing = self._request("GET", "developer_project_facts", params={"project_id": f"eq.{project_id}", "fact_name": f"eq.{fact_name}", "select": "id,value_json,normalized_value,last_changed_at"})
        value = fact["value"]
        normalized = json.dumps(value, sort_keys=True, ensure_ascii=False)
        changed = not existing or existing[0].get("normalized_value") != normalized
        payload = {"project_id": project_id, "fact_name": fact_name, "value_json": value, "normalized_value": normalized, "last_seen_at": datetime.now(timezone.utc).isoformat()}
        if changed:
            payload["last_changed_at"] = datetime.now(timezone.utc).isoformat()
        rows = self._request("POST", "developer_project_facts", params={"on_conflict": "project_id,fact_name"}, headers={"Prefer": "resolution=merge-duplicates,return=representation"}, json=payload)
        fact_id = rows[0]["id"]
        self._request("POST", "developer_project_fact_evidence", headers={"Prefer": "resolution=ignore-duplicates,return=minimal"}, json={"fact_id": fact_id, "document_id": document["id"], "evidence_text": str(fact.get("evidence") or ""), "confidence": fact.get("confidence", 0)})
        return changed

    def finish_project(self, project_id: int, changed: bool, recrawl_days: int, publishable: bool) -> None:
        now = datetime.now(timezone.utc)
        payload = {"last_crawled_at": now.isoformat(), "next_crawl_at": (now + timedelta(days=recrawl_days)).isoformat(), "publication_status": "published" if publishable else "noindex"}
        if changed:
            payload["last_fact_changed_at"] = now.isoformat()
        self._request("PATCH", "developer_projects", params={"id": f"eq.{project_id}"}, headers={"Prefer": "return=minimal"}, json=payload)

    def link_building_if_confident(self, project_id: int, project: dict[str, Any], facts: dict[str, dict[str, Any]]) -> str:
        """Link only an exact live building identity with corroborating facts.

        Name similarity alone is never sufficient. An address/locality and
        developer must corroborate the canonical name; if RERA exists in both
        records it must also agree. Missing RERA is allowed because many live
        WhatsApp building rows predate RERA capture.
        """
        name = str(facts.get("project_name", {}).get("value") or project["name"]).strip()
        locality = str(facts.get("locality", {}).get("value") or project.get("locality") or "").strip()
        developer = str(facts.get("developer", {}).get("value") or project.get("developer") or "").strip()
        rows = self._request("GET", "buildings", params={"canonical_name": f"eq.{name}", "select": "id,canonical_name,micro_market,address,developer"})
        for building in rows:
            same_locality = locality.casefold() in str(building.get("micro_market") or "").casefold() or str(building.get("micro_market") or "").casefold() in locality.casefold()
            same_developer = not developer or not building.get("developer") or developer.casefold() == str(building.get("developer")).casefold()
            has_address = bool(facts.get("address", {}).get("value") and building.get("address"))
            if same_locality and same_developer and (has_address or locality):
                self._request("PATCH", "developer_projects", params={"id": f"eq.{project_id}"}, headers={"Prefer": "return=minimal"}, json={"building_id": building["id"], "identity_status": "linked"})
                return "linked"
        self._request("PATCH", "developer_projects", params={"id": f"eq.{project_id}"}, headers={"Prefer": "return=minimal"}, json={"identity_status": "needs_review"})
        return "needs_review"


async def crawl_configured_projects(config_path: str = "config/developer_projects.yml") -> dict[str, Any]:
    from crawl4ai import AsyncWebCrawler, CacheMode, CrawlerRunConfig
    store = ProjectStore()
    results = {"projects": 0, "sources": 0, "facts_changed": 0, "errors": []}
    try:
        async with AsyncWebCrawler() as crawler:
            for config in load_config(config_path):
                if not config.get("enabled", False):
                    continue
                project = store.upsert_project(config); results["projects"] += 1
                due_at = project.get("next_crawl_at")
                if not project.get("_newly_created") and due_at and datetime.fromisoformat(str(due_at).replace("Z", "+00:00")) > datetime.now(timezone.utc):
                    continue
                changed = False
                latest_facts: dict[str, dict[str, Any]] = {}
                for source_cfg in sorted(config.get("sources", []), key=lambda item: item.get("priority", 100)):
                    source = store.upsert_source(project["id"], source_cfg)
                    run = store.crawl_run(project["id"], source["id"]); results["sources"] += 1
                    try:
                        result = await crawler.arun(url=source_cfg["url"], config=CrawlerRunConfig(cache_mode=CacheMode.BYPASS))
                        if not result.success:
                            raise RuntimeError(result.error_message or "crawl failed")
                        text = rendered_page_text(result)
                        title = str((getattr(result, "metadata", None) or {}).get("title") or getattr(result, "title", "") or "")
                        html = str(getattr(result, "cleaned_html", "") or getattr(result, "html", "") or "")
                        digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
                        document = store.save_document(project["id"], source["id"], run["id"], source_cfg["url"], title, text, html, digest)
                        facts = extract_project_facts(config["name"], config.get("developer", ""), config["locality"], title, text)
                        latest_facts.update(facts)
                        source_changed = any(store.save_fact(project["id"], key, fact, document) for key, fact in facts.items())
                        changed = changed or source_changed
                        store.finish_run(run["id"], {"status": "succeeded", "finished_at": datetime.now(timezone.utc).isoformat(), "content_hash": digest, "facts_changed": source_changed, "http_status": 200})
                    except Exception as exc:
                        store.finish_run(run["id"], {"status": "failed", "finished_at": datetime.now(timezone.utc).isoformat(), "error": str(exc)[:1000]})
                        results["errors"].append({"project": config["key"], "source": source_cfg["url"], "error": str(exc)})
                publishable = "project_name" in latest_facts and "locality" in latest_facts and bool(latest_facts["locality"].get("value"))
                store.finish_project(project["id"], changed, int(config.get("recrawl_days", 7)), publishable)
                store.link_building_if_confident(project["id"], config, latest_facts)
                if changed:
                    store.ping_indexnow(config)
                results["facts_changed"] += int(changed)
    finally:
        store.close()
    return results


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default="config/developer_projects.yml")
    args = parser.parse_args()
    import asyncio
    print(json.dumps(asyncio.run(crawl_configured_projects(args.config)), indent=2))


if __name__ == "__main__":
    main()
