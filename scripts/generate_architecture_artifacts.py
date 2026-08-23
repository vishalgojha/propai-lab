#!/usr/bin/env python3
"""Generate the architecture artifacts consumed by docs and the internal page.

The schema artifact queries Supabase's protected SQL bridge, which in turn reads
Postgres information_schema. The dependency artifact is deliberately a useful
boundary map rather than a claim of exhaustive static analysis.

Usage:
  python scripts/generate_architecture_artifacts.py
  python scripts/generate_architecture_artifacts.py --allow-source-fallback

Live generation requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or
SUPABASE_SERVICE_KEY). The fallback is only for local documentation work when
no database credentials are available; CI/deploy should use the live query.
"""

from __future__ import annotations

import argparse
import ast
import json
import os
import re
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "architecture" / "generated"

EXPLICIT_TABLES = {
    "listings_unified", "requirements_unified", "requirement_matches",
    "buildings", "building_name_aliases", "building_enrichment_jobs",
    "building_enrichment_evidence", "brokers", "broker_aliases",
    "raw_messages", "parsed_output_unified", "semantic_embeddings",
    "semantic_embedding_jobs", "worker_heartbeats",
    "workspace_blocked_brokers", "whatsapp_connections", "whatsapp_groups",
    "whatsapp_group_settings", "organization_members", "organizations",
}
TYPED_TABLES = {
    "residential_sale_listings", "residential_rent_listings",
    "commercial_sale_listings", "commercial_rent_listings",
    "residential_sale_requirements", "residential_rent_requirements",
    "commercial_sale_requirements", "commercial_rent_requirements",
}


def db_rows(sql: str) -> list[dict]:
    # Secrets are commonly pasted into GitHub/Coolify with a final newline.
    # Normalize both values before constructing an HTTP request; never let
    # whitespace turn into an invalid URL or an unmatchable credential.
    url = os.getenv("SUPABASE_URL", "").strip().rstrip("/")
    key = (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("SUPABASE_SERVICE_KEY") or "").strip()
    if not url or not key:
        raise RuntimeError("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY/SUPABASE_SERVICE_KEY are required")
    request = Request(
        f"{url}/rest/v1/rpc/propai_query_sql",
        data=json.dumps({"sql": sql, "params": []}).encode(),
        headers={"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urlopen(request, timeout=60) as response:
            body = json.loads(response.read().decode())
    except (HTTPError, URLError, TimeoutError) as exc:
        raise RuntimeError(f"Supabase schema query failed: {exc}") from exc
    if not isinstance(body, list):
        raise RuntimeError("Supabase schema query returned a non-list response")
    return body


def fallback_schema() -> tuple[list[dict], list[dict], list[dict]]:
    names = EXPLICIT_TABLES | TYPED_TABLES
    tables = [{"table_name": name, "table_type": "VIEW" if name.endswith("_unified") else "BASE TABLE"}
              for name in sorted(names)]
    columns = []
    for name in sorted(names):
        columns.extend([
            {"table_name": name, "column_name": "id", "data_type": "bigint", "is_nullable": "NO"},
            {"table_name": name, "column_name": "tenant_id", "data_type": "uuid", "is_nullable": "YES"},
        ])
    fks = []
    return tables, columns, fks


def fetch_schema(allow_fallback: bool) -> tuple[list[dict], list[dict], list[dict], bool]:
    table_sql = """
      select table_name, table_type
      from information_schema.tables
      where table_schema = 'public'
        and (table_name in (select unnest(array[%s]))
          or table_name like '%%_listings'
          or table_name like '%%_requirements'
          or table_name like '%%building%%'
          or table_name like '%%whatsapp%%'
          or table_name like '%%consent%%'
          or table_name like '%%organization%%'
          or table_name like '%%tenant%%')
      order by table_name
    """ % ",".join("'" + name.replace("'", "''") + "'" for name in sorted(EXPLICIT_TABLES))
    column_sql = """
      select c.table_name, c.column_name, c.data_type, c.is_nullable
      from information_schema.columns c
      join information_schema.tables t using (table_schema, table_name)
      where c.table_schema = 'public'
        and t.table_name in (select table_name from information_schema.tables
                             where table_schema = 'public'
                               and (table_name like '%%_listings' or table_name like '%%_requirements'
                                    or table_name like '%%building%%' or table_name like '%%whatsapp%%'
                                    or table_name like '%%consent%%' or table_name in (%s)))
      order by c.table_name, c.ordinal_position
    """ % ",".join("'" + name.replace("'", "''") + "'" for name in sorted(EXPLICIT_TABLES))
    fk_sql = """
      select tc.table_name, kcu.column_name, ccu.table_name as foreign_table_name,
             ccu.column_name as foreign_column_name
      from information_schema.table_constraints tc
      join information_schema.key_column_usage kcu
        on tc.constraint_name = kcu.constraint_name and tc.table_schema = kcu.table_schema
      join information_schema.constraint_column_usage ccu
        on ccu.constraint_name = tc.constraint_name and ccu.table_schema = tc.table_schema
      where tc.constraint_type = 'FOREIGN KEY' and tc.table_schema = 'public'
      order by tc.table_name, kcu.column_name
    """
    try:
        return db_rows(table_sql), db_rows(column_sql), db_rows(fk_sql), True
    except RuntimeError:
        if not allow_fallback:
            raise
        return (*fallback_schema(), False)


def mermaid_id(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9_]", "_", value)


def schema_mermaid(tables: list[dict], columns: list[dict], fks: list[dict], live: bool) -> str:
    selected = {row["table_name"] for row in tables}
    grouped: dict[str, list[dict]] = {}
    for row in columns:
        if row["table_name"] in selected:
            grouped.setdefault(row["table_name"], []).append(row)
    lines = ["%% AUTO-GENERATED by scripts/generate_architecture_artifacts.py. DO NOT EDIT.",
             f"%% Source: {'live Supabase information_schema' if live else 'source fallback; regenerate with Supabase credentials'}",
             "erDiagram"]
    for table in sorted(selected):
        lines.append(f"    {mermaid_id(table)} {{")
        cols = grouped.get(table) or [{"column_name": "id", "data_type": "bigint", "is_nullable": "NO"}]
        for col in cols:
            kind = re.sub(r"[^A-Za-z0-9_]", "_", str(col.get("data_type") or "text"))
            marker = " PK" if col.get("column_name") == "id" else ""
            if col.get("column_name") == "tenant_id":
                marker = " FK"
            lines.append(f"        {kind} {mermaid_id(str(col['column_name']))}{marker}")
        lines.append("    }")
    for fk in fks:
        if fk.get("table_name") in selected and fk.get("foreign_table_name") in selected:
            lines.append(f"    {mermaid_id(fk['table_name'])} ||--o{{ {mermaid_id(fk['foreign_table_name'])} : \"{fk['column_name']}\"")
    return "\n".join(lines) + "\n"


def py_modules() -> list[Path]:
    paths = [ROOT / "app.py", ROOT / "extraction.py", ROOT / "ai_extraction.py",
             ROOT / "semantic_embeddings.py", ROOT / "semantic_embedding_worker.py"]
    paths.extend(sorted((ROOT / "routers").glob("*.py")))
    paths.extend(sorted((ROOT / "matching").glob("*.py")))
    return [path for path in paths if path.exists()]


def import_names(path: Path) -> set[str]:
    try:
        tree = ast.parse(path.read_text(encoding="utf-8"))
    except (OSError, SyntaxError):
        return set()
    names: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            names.update(alias.name.split(".")[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            names.add(node.module.split(".")[0])
    return names


def dependency_mermaid() -> str:
    lines = ["%% AUTO-GENERATED by scripts/generate_architecture_artifacts.py. DO NOT EDIT.",
             "%% This is a boundary map, not an exhaustive dependency proof.", "flowchart LR"]
    nodes: dict[str, str] = {}
    edges: set[tuple[str, str]] = set()
    paths = py_modules()
    known = {path.stem for path in paths}
    known.update({"routers", "matching", "storage"})
    for path in paths:
        name = path.stem if path.parent.name not in {"routers", "matching"} else f"{path.parent.name}.{path.stem}"
        node = mermaid_id(name)
        nodes[node] = name
        imports = import_names(path)
        for imported in imports:
            target = next((candidate for candidate in known if candidate == imported or candidate.endswith(f".{imported}")), None)
            if target and target != name:
                edges.add((node, mermaid_id(target)))
    lines.append("    subgraph Backend[FastAPI backend]")
    for node, label in sorted(nodes.items()):
        lines.append(f"        {node}[\"{label}\"]")
    lines.append("    end")
    lines.append("    subgraph Frontend[Next.js route boundaries]")
    for page in sorted((ROOT / "frontend/src/app").glob("**/page.tsx")):
        route = "/" + str(page.parent.relative_to(ROOT / "frontend/src/app"))
        if route == "/.":
            route = "/"
        route = route.replace("/page", "").replace("\\", "/")
        node = mermaid_id("route_" + route)
        lines.append(f"        {node}[\"{route}\"]")
    lines.append("    end")
    for source, target in sorted(edges):
        lines.append(f"    {source} --> {target}")
    for page in sorted((ROOT / "frontend/src/app").glob("**/page.tsx")):
        route = "/" + str(page.parent.relative_to(ROOT / "frontend/src/app"))
        if route == "/.":
            route = "/"
        node = mermaid_id("route_" + route)
        content = page.read_text(encoding="utf-8", errors="ignore")
        for endpoint in sorted(set(re.findall(r"fetchJSON(?:<[^>]+>)?\(\s*[\"'](/[^\"']+)", content))):
            api_node = mermaid_id("api_" + endpoint)
            lines.append(f"    {node} -.-> {api_node}[\"{endpoint}\"]")
    return "\n".join(lines) + "\n"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--allow-source-fallback", action="store_true")
    parser.add_argument("--output-dir", type=Path, default=OUT)
    args = parser.parse_args()
    tables, columns, fks, live = fetch_schema(args.allow_source_fallback)
    output = args.output_dir if args.output_dir.is_absolute() else ROOT / args.output_dir
    output.mkdir(parents=True, exist_ok=True)
    (output / "schema.mmd").write_text(schema_mermaid(tables, columns, fks, live), encoding="utf-8")
    (output / "dependencies.mmd").write_text(dependency_mermaid(), encoding="utf-8")
    (output / "manifest.json").write_text(json.dumps({"schema_source": "live" if live else "fallback", "tables": len(tables)}, indent=2) + "\n", encoding="utf-8")
    print(f"Generated {output / 'schema.mmd'} and {output / 'dependencies.mmd'} ({'live' if live else 'fallback'} schema)")


if __name__ == "__main__":
    main()
