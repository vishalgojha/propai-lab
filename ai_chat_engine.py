import os
import json
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
        "listings": ("Property listings for sale/rent in Mumbai", ["propi_listings.csv", "listings.csv"]),
        "buildings": ("Building and address records", ["propi_buildings.csv", "buildings.csv"]),
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
                if key == "listings":
                    df = _prepare_listings(df)
                sources[key] = {"df": df, "description": desc}
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
    return f"""You are a Mumbai real estate data assistant. You answer questions about these datasets:

{overview}

RULES:
- Answer directly. Greet once per conversation but don't list off datasets.
- Use Indian Rupee (₹) format for prices (e.g. ₹1.2 Cr, ₹85 L).
- Use the query_data tool to look up data.
- Do NOT make up data. If the data doesn't have an answer, say so plainly."""


TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "query_data",
            "description": "Filter, aggregate, or list records from a dataset",
            "parameters": {
                "type": "object",
                "properties": {
                    "source": {
                        "type": "string",
                        "enum": ["listings", "buildings"],
                        "description": "Which dataset to query: listings (properties for sale/rent) or buildings (address records)",
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
    resp = client.chat.completions.create(
        model=MODEL,
        messages=messages,
        tools=TOOLS,
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
