import os
import json
import sqlite3
import datetime
import pandas as pd
from openai import OpenAI

MODEL = os.getenv("DOUBLEWORD_MODEL", "Qwen/Qwen3.6-35B-A3B-FP8")
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

    # Unresolved messages (parser gaps)
    unresolved = con.execute("""
        SELECT p.id, p.intent, p.bhk, p.price, p.micro_market,
               p.broker_name, p.confidence, p.created_at,
               r.message, r.group_name, r.timestamp,
               d.method, d.failure_category
        FROM parsed_output p
        JOIN raw_messages r ON r.id = p.raw_message_id
        LEFT JOIN resolver_decisions d ON d.parsed_id = p.id
        WHERE d.method = 'unresolved' OR p.confidence < 0.5
        ORDER BY p.id DESC
        LIMIT 500
    """).fetchall()
    if unresolved:
        sources["unresolved_messages"] = {"df": pd.DataFrame([dict(r) for r in unresolved]),
                                           "description": "Messages the parser couldn't fully understand or resolve — needs human review"}

    # Pending AI suggestions
    suggestions = con.execute("""
        SELECT id, agent, suggestion_type, title, description, confidence, status, created_at
        FROM ai_suggestions
        WHERE status = 'pending'
        ORDER BY created_at DESC
        LIMIT 200
    """).fetchall()
    if suggestions:
        sources["pending_suggestions"] = {"df": pd.DataFrame([dict(r) for r in suggestions]),
                                           "description": "AI suggestions waiting for human review and approval"}

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
- Use create_suggestion when the user asks you to make changes (create buildings, merge profiles, add aliases, flag issues).
- Do NOT make up data. If you don't know, say so plainly.
- When the user asks you to DO something (create, merge, flag, add), call create_suggestion. Tell the user what you suggested."""


def _suggestion_tool():
    return {
        "type": "function",
        "function": {
            "name": "create_suggestion",
            "description": "Create a Review Center suggestion that needs human approval. Use this when the user asks you to make changes — like creating a building, merging brokers, adding aliases, flagging data issues. The suggestion will appear in the Review Center for approval.",
            "parameters": {
                "type": "object",
                "properties": {
                    "agent": {
                        "type": "string",
                        "enum": ["building", "location", "merge_broker", "duplicate_listing", "alias", "quality", "user_request"],
                        "description": "Which agent category this suggestion belongs to",
                    },
                    "suggestion_type": {
                        "type": "string",
                        "description": "Type of action — e.g. 'create_alias', 'merge', 'flag', 'add_building', 'review'",
                    },
                    "title": {
                        "type": "string",
                        "description": "Short title for the suggestion card (e.g. 'Create building: Chandak Unicorn')",
                    },
                    "description": {
                        "type": "string",
                        "description": "Detailed description explaining what needs to be done and why",
                    },
                    "proposal_data": {
                        "type": "object",
                        "description": "Structured data with the proposed action details",
                    },
                    "confidence": {
                        "type": "number",
                        "description": "Confidence in this suggestion (0.0 to 1.0). Use 0.85 for AI-generated, 0.95 for clear deterministic matches.",
                    },
                },
                "required": ["agent", "suggestion_type", "title", "description", "proposal_data", "confidence"],
            },
        },
    }


def _build_tools(sources):
    source_keys = sorted(sources.keys())
    tools = [
        _suggestion_tool(),
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
        {
            "type": "function",
            "function": {
                "name": "find_parser_gaps",
                "description": "Find messages the parser couldn't understand — unresolved locations, low confidence parses, missing fields. Helps identify what knowledge the system is missing.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "category": {
                            "type": "string",
                            "enum": ["unresolved_location", "low_confidence", "missing_bhk", "missing_price", "no_intent", "all"],
                            "description": "Category of parser gaps to find",
                        },
                        "limit": {"type": "integer", "description": "Max results (default 10)"},
                    },
                    "required": ["category"],
                },
            }
        },
        {
            "type": "function",
            "function": {
                "name": "find_duplicates",
                "description": "Find potential duplicate listings, brokers, or buildings that may need merging",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "entity_type": {
                            "type": "string",
                            "enum": ["listings", "brokers", "buildings"],
                            "description": "Type of entity to check for duplicates",
                        },
                        "limit": {"type": "integer", "description": "Max results (default 10)"},
                    },
                    "required": ["entity_type"],
                },
            }
        },
    ]
    return tools


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


def _open_db():
    """Open a connection to lab.db for operational queries."""
    lab_dir = os.path.realpath(os.path.dirname(os.path.abspath(__file__)))
    db_path = os.path.join(lab_dir, "lab.db")
    if not os.path.exists(db_path):
        return None
    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row
    return con


def execute_tool(name, args, sources, db_path=None):
    if name == "get_overview":
        return build_overview(sources)

    if name == "create_suggestion":
        try:
            con = sqlite3.connect(db_path or "")
            agent = args.get("agent", "user_request")
            sug_type = args.get("suggestion_type", "review")
            title = args.get("title", "")
            description = args.get("description", "")
            proposal = json.dumps(args.get("proposal_data", {}))
            confidence = args.get("confidence", 0.85)
            con.execute("""
                INSERT INTO ai_suggestions
                    (agent, suggestion_type, title, description, source_data, proposal_data, confidence, status, created_at, updated_at)
                VALUES (?, ?, ?, ?, '{}', ?, ?, 'pending', datetime('now'), datetime('now'))
            """, (agent, sug_type, title, description, proposal, confidence))
            con.commit()
            sug_id = con.execute("SELECT last_insert_rowid()").fetchone()[0]
            con.close()
            return f"✅ Suggestion created (ID {sug_id}): \"{title}\". It's now in the Review Center waiting for approval."
        except Exception as e:
            return f"❌ Failed to create suggestion: {e}"

    if name == "find_parser_gaps":
        con = _open_db()
        if not con:
            return "Database not available"
        try:
            category = args.get("category", "all")
            limit = args.get("limit", 10)
            if category == "unresolved_location":
                rows = con.execute("""
                    SELECT p.id, p.intent, p.micro_market, p.broker_name, p.confidence,
                           p.location_raw, r.message, r.group_name
                    FROM parsed_output p
                    JOIN raw_messages r ON r.id = p.raw_message_id
                    LEFT JOIN resolver_decisions d ON d.parsed_id = p.id
                    WHERE d.method = 'unresolved'
                    ORDER BY p.id DESC LIMIT ?
                """, (limit,)).fetchall()
            elif category == "low_confidence":
                rows = con.execute("""
                    SELECT p.id, p.intent, p.micro_market, p.broker_name, p.confidence,
                           p.location_raw, r.message, r.group_name
                    FROM parsed_output p
                    JOIN raw_messages r ON r.id = p.raw_message_id
                    WHERE p.confidence < 0.5 AND p.confidence > 0
                    ORDER BY p.confidence ASC LIMIT ?
                """, (limit,)).fetchall()
            elif category == "missing_bhk":
                rows = con.execute("""
                    SELECT p.id, p.intent, p.price, p.micro_market, p.broker_name,
                           r.message, r.group_name
                    FROM parsed_output p
                    JOIN raw_messages r ON r.id = p.raw_message_id
                    WHERE (p.bhk IS NULL OR p.bhk = '') AND p.intent IN ('SELL','RENT')
                    ORDER BY p.id DESC LIMIT ?
                """, (limit,)).fetchall()
            elif category == "missing_price":
                rows = con.execute("""
                    SELECT p.id, p.intent, p.bhk, p.micro_market, p.broker_name,
                           r.message, r.group_name
                    FROM parsed_output p
                    JOIN raw_messages r ON r.id = p.raw_message_id
                    WHERE (p.price IS NULL OR p.price = 0) AND p.intent IN ('SELL','RENT')
                    ORDER BY p.id DESC LIMIT ?
                """, (limit,)).fetchall()
            else:
                rows = con.execute("""
                    SELECT p.id, p.intent, p.confidence, p.micro_market, p.broker_name,
                           d.method, d.failure_category,
                           r.message, r.group_name
                    FROM parsed_output p
                    JOIN raw_messages r ON r.id = p.raw_message_id
                    LEFT JOIN resolver_decisions d ON d.parsed_id = p.id
                    WHERE d.method = 'unresolved' OR p.confidence < 0.5
                    ORDER BY p.id DESC LIMIT ?
                """, (limit,)).fetchall()
            if not rows:
                return f"No {category} issues found. The parser is doing well!"
            lines = [f"Found {len(rows)} {'parser gap' if len(rows)==1 else 'parser gaps'}:"]
            for r in rows:
                d = dict(r)
                msg = (d.get("message") or "")[:80]
                lines.append(f"• [ID {d['id']}] {d.get('intent','?')} | {d.get('broker_name','?')} | {d.get('micro_market','?')} | conf={d.get('confidence',0)}")
                lines.append(f"  {msg}")
            return "\n".join(lines)
        finally:
            con.close()

    if name == "find_duplicates":
        con = _open_db()
        if not con:
            return "Database not available"
        try:
            entity_type = args.get("entity_type", "listings")
            limit = args.get("limit", 10)
            if entity_type == "brokers":
                rows = con.execute("""
                    SELECT a.id AS keep_id, b.id AS merge_id,
                           a.canonical_name AS keep_name, b.canonical_name AS merge_name,
                           a.primary_phone, a.observation_count
                    FROM brokers a
                    JOIN brokers b ON b.id > a.id
                    WHERE a.primary_phone IS NOT NULL AND a.primary_phone != ''
                      AND a.primary_phone = b.primary_phone
                    ORDER BY a.observation_count DESC
                    LIMIT ?
                """, (limit,)).fetchall()
                if rows:
                    lines = [f"Found {len(rows)} potential broker merge:"]
                    for r in rows:
                        lines.append(f"• Keep '{r['keep_name']}' (ID {r['keep_id']}) ← Merge '{r['merge_name']}' (ID {r['merge_id']}) — Phone: {r['primary_phone']}")
                    return "\n".join(lines)
                return "No duplicate brokers found."
            elif entity_type == "buildings":
                rows = con.execute("""
                    SELECT a.alias AS name_a, b.alias AS name_b,
                           a.canonical AS canonical
                    FROM building_aliases a
                    JOIN building_aliases b ON b.canonical = a.canonical AND b.alias < a.alias
                    LIMIT ?
                """, (limit,)).fetchall()
                if rows:
                    lines = [f"Found {len(rows)} building alias groups:"]
                    for r in rows:
                        lines.append(f"• '{r['name_a']}' and '{r['name_b']}' → canonical: '{r['canonical']}'")
                    return "\n".join(lines)
                return "No building alias groups found."
            else:
                rows = con.execute("""
                    SELECT fingerprint, intent, bhk, price, building_name,
                           broker_name, location_label, observation_count
                    FROM listings
                    WHERE observation_count > 1
                    ORDER BY observation_count DESC
                    LIMIT ?
                """, (limit,)).fetchall()
                if rows:
                    lines = [f"Found {len(rows)} listings with multiple observations (potential duplicates):"]
                    for r in rows:
                        lines.append(f"• {r['building_name'] or '?'} | {r['bhk'] or '?'} | ₹{r['price'] or '?'} | {r['broker_name'] or '?'} — seen {r['observation_count']}x")
                    return "\n".join(lines)
                return "No duplicate listings found."
        finally:
            con.close()

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


def _default_db_path():
    lab_dir = os.path.realpath(os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(lab_dir, "lab.db")


def get_model_reply(messages, sources, api_key=None, db_path=None, model=None):
    client = get_client(api_key=api_key)
    tools = _build_tools(sources)
    db_path = db_path or _default_db_path()
    resp = client.chat.completions.create(
        model=model or MODEL,
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
            result = execute_tool(fn_name, fn_args, sources, db_path=db_path)
            result_str = str(result) if not isinstance(result, str) else result
            messages.append({
                "role": "tool",
                "tool_call_id": tc.id,
                "content": result_str,
            })
        return get_model_reply(messages, sources, api_key=api_key, db_path=db_path, model=model)

    return msg
