"""Dry-run Crawl4AI pilot; never writes to Supabase."""

import argparse
import json
import os

from agents.building_enrichment.crawl_discovery import crawl_discovery_pages_sync

DEFAULT_SOURCE_TEMPLATES = [
    # Official MahaRERA project search. Crawl4AI handles the rendered result
    # page; the pilot only records evidence and never writes coordinates.
    "https://www.maharera.maharashtra.gov.in/projects-search-result?project_name={query}&project_state=27",
]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("names", nargs="+", help="Building names to investigate")
    parser.add_argument(
        "--url-template",
        action="append",
        dest="templates",
        default=None,
        help="Explicit source URL template containing {query} (repeatable)",
    )
    parser.add_argument("--output", default="building_discovery_pilot.json")
    args = parser.parse_args()

    templates = args.templates or [
        value for value in os.getenv("BUILDING_DISCOVERY_URL_TEMPLATES", "").split(",")
        if value.strip()
    ] or DEFAULT_SOURCE_TEMPLATES

    results = crawl_discovery_pages_sync(args.names, templates)
    with open(args.output, "w", encoding="utf-8") as handle:
        json.dump([candidate.to_dict() for candidate in results], handle, indent=2, ensure_ascii=False)
    print(f"Wrote {len(results)} dry-run candidates to {args.output}; database unchanged")


if __name__ == "__main__":
    main()
