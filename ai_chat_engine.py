import os
import json
import sqlite3
import pandas as pd
from openai import OpenAI

MODEL = "Qwen/Qwen3.6-35B-A3B-FP8"
BASE_URL = "https://api.doubleword.ai/v1"
_lab_dir = os.path.realpath(os.path.dirname(os.path.abspath(__file__)))
_propai_data = os.path.realpath(os.path.join(_lab_dir, "..", "propai", "data"))
DATA_DIR = _propai_data if os.path.isdir(_propai_data) else os.path.join(_lab_dir, "data")

_client = None


def get_client(api_key=None):
    global _client
    key = api_key or os.environ.get("DOUBLEWORD_API_KEY", "")
    if _client is None or _client.api_key != key:
        _client = OpenAI(api_key=key, base_url=BASE_URL)
    return _client


def load_data():
    sources = {}
    files = {
        "portal_listings": ("Property listings collected from online portals", ["propi_listings.csv", "listings.csv"]),
        "buildings": ("Building and address directory", ["propi_buildings.csv", "buildings.csv"]),
    }
    for key, (desc, candidates) in files.items():
        path = None
        for fn in candidates:
            p = os.path.join(DATA_DIR, fn)
            if os.path.exists(p):
                path = p
                break
        if path is None:
            continue
        if os.path.exists(path):
            df = pd.read_csv(path)
            if not df.empty:
                if key == "portal_listings":
                    df = _prepare_listings(df)
                sources[key] = {"df": df, "description": desc}
    return sources


def load_live_data(db_path):
    """Load live SQLite tables as additional sources with broker-friendly names."""
    if not os.path.exists(db_path):
        return {}
    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row
    sources = {}

    raw_cnt = con.execute("SELECT COUNT(*) FROM raw_messages").fetchone()[0]
    parsed_cnt = con.execute("SELECT COUNT(*) FROM parsed_output").fetchone()[0]
    sources["overview"] = {
        "df": pd.DataFrame([{
            "total_messages": raw_cnt,
            "total_properties_posted": parsed_cnt,
            "total_brokers": con.execute("SELECT COUNT(*) FROM brokers").fetchone()[0],
            "unique_properties": con.execute("SELECT COUNT(*) FROM listings").fetchone()[0],
            "building_matches_found": con.execute("SELECT COUNT(*) FROM resolver_decisions WHERE method='resolved'").fetchone()[0],
        }]),
        "description": "Platform overview with total counts of messages, properties, brokers, and matched buildings",
    }

    brokers = con.execute(
        "SELECT canonical_name AS name, primary_phone AS phone, "
        "observation_count AS total_posts, listing_count AS properties_posted, "
        "requirement_count AS requirements_posted, rental_count AS rentals_posted, "
        "commercial_count AS commercial_posted, group_count AS groups_active, "
        "market_count AS markets_served, "
        "avg_ticket AS average_price, first_seen_at AS first_active, last_seen_at AS last_active "
        "FROM brokers ORDER BY observation_count DESC LIMIT 2000"
    ).fetchall()
    if brokers:
        df = pd.DataFrame([dict(r) for r in brokers])
        if "average_price" in df.columns:
            df["average_price"] = pd.to_numeric(df["average_price"], errors="coerce")
        sources["brokers"] = {"df": df, "description": "Brokers with their activity, markets, and average prices"}

    listings = con.execute(
        "SELECT fingerprint, intent, bhk, price, price_unit, area_sqft, furnishing, "
        "location_label AS area, building_name, landmark_name, micro_market, "
        "broker_name, broker_phone, "
        "observation_count AS times_seen, group_count AS groups_seen_in, "
        "first_seen, last_seen FROM listings ORDER BY last_seen DESC LIMIT 5000"
    ).fetchall()
    if listings:
        sources["unique_listings"] = {"df": pd.DataFrame([dict(r) for r in listings]),
                                       "description": "Unique properties posted in WhatsApp groups"}

    obs = con.execute(
        "SELECT p.intent AS purpose, p.bhk, p.price, p.price_unit, p.area_sqft, "
        "p.furnishing, p.building_name, p.micro_market AS locality, "
        "p.broker_name, p.broker_phone, "
        "p.forwarded, p.created_at AS posted_at, "
        "r.group_name AS group_name, r.sender AS posted_by, r.timestamp "
        "FROM parsed_output p JOIN raw_messages r ON r.id = p.raw_message_id "
        "ORDER BY p.id DESC LIMIT 10000"
    ).fetchall()
    if obs:
        df = pd.DataFrame([dict(r) for r in obs])
        for c in ["price", "area_sqft"]:
            if c in df.columns:
                df[c] = pd.to_numeric(df[c], errors="coerce")
        sources["market_feed"] = {"df": df, "description": "Recent property posts and requirements posted in WhatsApp groups"}

    resolved = con.execute(
        "SELECT rd.building_name AS matched_building, rd.landmark_name AS matched_landmark, "
        "p.intent AS purpose, p.micro_market AS locality, "
        "rd.method AS match_status, rd.final_confidence AS match_confidence, "
        "rd.failure_category, rd.created_at "
        "FROM resolver_decisions rd JOIN parsed_output p ON p.id = rd.parsed_id "
        "ORDER BY rd.id DESC LIMIT 10000"
    ).fetchall()
    if resolved:
        sources["building_matches"] = {"df": pd.DataFrame([dict(r) for r in resolved]),
                                        "description": "Which properties were matched to known buildings and landmarks"}

    con.close()
    return sources


def build_overview(sources):
    lines = []
    for key, src in sources.items():
        df = src["df"]
        lines.append(f"-- {src['description']} --")
        lines.append(f"  Rows: {len(df)}")
        lines.append(f"  Columns: {', '.join(df.columns)}")
        for col in df.columns:
            if df[col].dtype == "object":
                uniq = df[col].dropna().unique()
                if len(uniq) <= 15:
                    vals = ", ".join(str(u) for u in uniq)
                else:
                    vals = f"{len(uniq)} unique values (e.g. {uniq[0]}, {uniq[1]}, ...)"
                lines.append(f"  {col}: {vals}")
        num_cols = df.select_dtypes(include="number").columns
        if len(num_cols):
            lines.append(f"  Numeric columns: {', '.join(num_cols)}")
            for c in num_cols:
                lines.append(f"    {c}: min={df[c].min()}, max={df[c].max()}, mean={df[c].mean():.1f}")
        lines.append("")
    return "\n".join(lines)


def build_system_prompt(sources):
    overview = build_overview(sources)
    return f"""You are a Mumbai real estate data assistant helping brokers. Answer questions about properties, brokers, and market activity.

AVAILABLE DATA:
{overview}

RULES:
- Answer in plain English. Never use technical terms like "observation", "entity", "resolve", "dataset" — say "message", "property", "match", "data".
- Use Indian Rupee (₹) format for prices (e.g. ₹1.2 Cr, ₹85 L).
- Use the query_data tool to look up information.
- Do NOT make up data. If you don't know, say so plainly."""


def _build_tools(sources):
    source_keys = sorted(sources.keys())
    return [
        {
            "type": "function",
            "function": {
                "name": "query_data",
                "description": "Search, filter, aggregate, or list records from any dataset",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "source": {
                            "type": "string",
                            "enum": source_keys,
                            "description": f"Which dataset to query. Available: {', '.join(source_keys)}",
                        },
                        "filters": {
                            "type": "object",
                            "description": "Column->value filters (exact match, case-insensitive)."
                            "For partial text match use {{'col__contains': 'text'}}."
                            "For numeric ranges use {{'col__lt': N, 'col__gt': N, 'col__lte': N, 'col__gte': N}}.",
                        },
                        "aggregate": {
                            "type": "string",
                            "enum": ["count", "list", "avg", "min", "max", "none"],
                            "description": "What to do with matching rows (default: list)",
                        },
                        "group_by": {
                            "type": "string",
                            "description": "Column to group by when using count/avg/min/max aggregate",
                        },
                        "sort_by": {"type": "string", "description": "Column to sort results by"},
                        "ascending": {"type": "boolean", "description": "Sort ascending (default: true)"},
                        "limit": {"type": "integer", "description": "Max rows to return (default 20)"},
                    },
                    "required": ["source"],
                },
            }
        },
        {
            "type": "function",
            "function": {
                "name": "get_overview",
                "description": "Get an overview of all available datasets (schema, row counts, sample values)",
                "parameters": {"type": "object", "properties": {}},
            },
        },
    ]


def _parse_price(val):
    if isinstance(val, (int, float)):
        return float(val)
    s = str(val).replace("₹", "").replace(",", "").strip()
    if "cr" in s.lower():
        return float(s.lower().replace("cr", "").strip()) * 1_00_00_000
    if "l" in s.lower() and not any(c.isdigit() for c in s.lower().replace("l", "")):
        return float(s.lower().replace("l", "").strip()) * 1_00_000
    try:
        return float(s)
    except ValueError:
        return None


def _prepare_listings(df):
    if "price" in df.columns and "price_numeric" not in df.columns:
        df["price_numeric"] = df["price"].apply(_parse_price)
    return df


_PRICE_COLS = {"price", "price_numeric"}


def apply_filters(df, filters):
    if not filters:
        return df
    for key, value in filters.items():
        raw_col = key.replace("__contains", "").replace("__lt", "").replace("__gt", "").replace("__lte", "").replace("__gte", "")
        col = raw_col
        if col in _PRICE_COLS and "price_numeric" in df.columns:
            col = "price_numeric"
        if key.endswith("__contains"):
            df = df[df[col].astype(str).str.contains(str(value), case=False, na=False)]
        elif key.endswith("__lt"):
            df = df[df[col].astype(float) < float(value)]
        elif key.endswith("__gt"):
            df = df[df[col].astype(float) > float(value)]
        elif key.endswith("__lte"):
            col = key.replace("__lte", "")
            df = df[df[col].astype(float) <= float(value)]
        elif key.endswith("__gte"):
            col = key.replace("__gte", "")
            df = df[df[col].astype(float) >= float(value)]
        else:
            df = df[df[key].astype(str).str.lower() == str(value).lower()]
    return df


def fmt_price(val):
    try:
        v = float(val)
        if v >= 1_00_00_000:
            return f"₹{v / 1_00_00_000:.2f} Cr"
        elif v >= 1_00_000:
            return f"₹{v / 1_00_000:.1f} L"
        else:
            return f"₹{v:,.0f}"
    except (ValueError, TypeError):
        return str(val)


def execute_tool(name, args, sources):
    if name == "get_overview":
        return build_overview(sources)

    if name == "query_data":
        source = args.get("source")
        if source not in sources:
            return f"Dataset '{source}' not found. Available: {', '.join(sources.keys())}"
        df = sources[source]["df"].copy()
        df = apply_filters(df, args.get("filters"))
        aggregate = args.get("aggregate", "list")
        group_by = args.get("group_by")
        sort_by = args.get("sort_by")
        ascending = args.get("ascending", True)
        limit = args.get("limit", 20)

        if df.empty:
            return "No records match the given filters."

        if aggregate == "count":
            if group_by:
                result = df.groupby(group_by).size().reset_index(name="count")
                result = result.sort_values("count", ascending=False)
                return result.to_string(index=False)
            return f"Count: {len(df)}"

        if aggregate in ("avg", "min", "max"):
            if not group_by:
                return f"{aggregate} requires a group_by column"
            num_cols = df.select_dtypes(include="number").columns
            if len(num_cols) == 0:
                return "No numeric columns to aggregate"
            agg_col = num_cols[0]
            func_map = {"avg": "mean", "min": "min", "max": "max"}
            result = df.groupby(group_by)[agg_col].agg(func_map[aggregate]).reset_index()
            result = result.sort_values(agg_col, ascending=False)
            return result.to_string(index=False)

        if sort_by and sort_by in df.columns:
            df = df.sort_values(sort_by, ascending=ascending)
        elif sort_by in _PRICE_COLS and "price_numeric" in df.columns:
            df = df.sort_values("price_numeric", ascending=ascending)

        if limit:
            df = df.head(limit)

        rows = df.to_dict("records")
        lines = []
        for i, row in enumerate(rows, 1):
            parts = []
            for col, val in row.items():
                if "price" in col.lower() or "value" in col.lower() or "amount" in col.lower():
                    val = fmt_price(val)
                parts.append(f"{col}={val}")
            lines.append(f"{i}. {' | '.join(parts)}")
        return "\n".join(lines)

    return f"Unknown tool: {name}"


def get_model_reply(messages, sources, api_key=None):
    client = get_client(api_key=api_key)
    tools = _build_tools(sources)
    resp = client.chat.completions.create(
        model=MODEL,
        messages=messages,
        tools=tools,
        tool_choice="auto",
        extra_body={"chat_template_kwargs": {"enable_thinking": False}},
    )
    msg = resp.choices[0].message
    messages.append(msg)

    if msg.tool_calls:
        for tc in msg.tool_calls:
            fn_name = tc.function.name
            try:
                fn_args = json.loads(tc.function.arguments)
            except json.JSONDecodeError:
                fn_args = {}
            result = execute_tool(fn_name, fn_args, sources)
            result_str = str(result) if not isinstance(result, str) else result
            messages.append({
                "role": "tool",
                "tool_call_id": tc.id,
                "content": result_str,
            })
        return get_model_reply(messages, sources, api_key=api_key)

    return msg
