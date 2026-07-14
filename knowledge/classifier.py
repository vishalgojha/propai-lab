"""
AI-powered classification for knowledge records.
Uses the existing Qwen model to classify and extract metadata.
"""

import json
import os
from pathlib import Path

from openai import OpenAI


MODEL = os.getenv("DOUBLEWORD_MODEL", "Qwen/Qwen3.6-35B-A3B-FP8")
BASE_URL = "https://api.doubleword.ai/v1"

_client = None


def _open_db_handle(db_path: Path | str):
    if hasattr(db_path, "execute"):
        return db_path
    supabase_url = os.getenv("SUPABASE_URL", "")
    supabase_key = os.getenv("SUPABASE_SERVICE_KEY", "")
    if supabase_url and supabase_key:
        try:
            from storage import SupabaseStorage

            return SupabaseStorage(supabase_url, supabase_key).db
        except Exception:
            return None
    return None


def _get_client():
    global _client
    # Try loading from lab.config first
    try:
        from lab.config import DOUBLEWORD_API_KEY
        key = DOUBLEWORD_API_KEY
    except ImportError:
        key = os.environ.get("DOUBLEWORD_API_KEY", "")
    
    if not key:
        return None
    
    if _client is None or _client.api_key != key:
        _client = OpenAI(api_key=key, base_url=BASE_URL)
    return _client


CLASSIFICATION_PROMPT = """You are a real estate knowledge classifier for an Indian property market AI.

Classify the following WhatsApp message and extract structured metadata.

Message:
\"\"\"
{message}
\"\"\"

Respond with ONLY a JSON object (no markdown, no explanation):
{{
  "content_type": "listing|requirement|inquiry|notification|social|unknown",
  "intent": "SELL|BUY|RENT|RENTAL_SEEKER|INQUIRY|NONE",
  "confidence": 0.0-1.0,
  "building_name": "extracted building name or null",
  "market": "extracted market/locality or null",
  "bhk": "1|1.5|2|2.5|3|4|5|6|null (number of BHK, 0.5 for 1RK)",
  "price": "extracted price as number or null",
  "price_unit": "CR|L|null",
  "furnishing": "FULLY_FURNISHED|SEMI_FURNISHED|UNFURNISHED|null",
  "property_type": "APARTMENT|VILLA|PLOT|OFFICE|SHOP|WAREHOUSE|land|null",
  "area_sqft": "extracted area as number or null",
  "tags": ["list", "of", "relevant", "tags"]
}}

Rules:
- content_type: "listing" if selling/renting property, "requirement" if looking to buy/rent, "inquiry" if asking questions, "notification" if general announcement, "social" if casual chat
- intent: SELL if offering property, BUY if wanting to purchase, RENT if offering rental, RENTAL_SEEKER if looking to rent, INQUIRY if asking, NONE if not relevant
- building_name: Extract proper building/project names (e.g., "Parijat Building", "Lodha Excel")
- market: Extract locality names (e.g., "Bandra West", "Andheri East", "Powai")
- bhk: Number of bedrooms (1RK = 0.5)
- price: Numeric value only (e.g., 2.5 for 2.5 Cr, 85 for 85 L)
- price_unit: CR for crore, L for lakh
- furnishing: Best match from options
- tags: Any relevant tags like "new", "urgent", "negotiable", "ready to move", etc.

If the message is not about real estate, set content_type to "social" or "unknown" and confidence to 0.3 or lower."""


def classify_message(message: str) -> dict:
    """Classify a single message using AI."""
    client = _get_client()
    
    if not client:
        return {
            "content_type": "unknown",
            "intent": "NONE",
            "confidence": 0.0,
            "error": "API key not configured",
        }

    # Use a simpler, more focused prompt
    prompt = f"""Classify this real estate WhatsApp message.

Message: "{message[:1500]}"

Return ONLY a JSON object with these fields:
- content_type: "listing" (selling/renting), "requirement" (looking to buy/rent), "inquiry" (questions), "notification" (announcement), "social" (casual), "unknown"
- intent: "SELL", "BUY", "RENT", "RENTAL_SEEKER", "INQUIRY", or "NONE"
- building_name: extracted building name or null
- market: extracted locality/market or null
- bhk: number (1, 1.5, 2, 2.5, 3, 4, 5) or null
- price: numeric value or null
- price_unit: "CR", "L", or null
- furnishing: "FULLY_FURNISHED", "SEMI_FURNISHED", "UNFURNISHED", or null
- confidence: 0.0 to 1.0

Example response:
{{"content_type": "listing", "intent": "SELL", "building_name": "Parijat Building", "market": "Bandra West", "bhk": 2, "price": 2.5, "price_unit": "CR", "furnishing": "SEMI_FURNISHED", "confidence": 0.9}}"""

    for attempt in range(3):  # Retry up to 3 times
        try:
            resp = client.chat.completions.create(
                model=MODEL,
                messages=[{"role": "user", "content": prompt}],
                temperature=0.1,
                max_tokens=300,
            )

            content = resp.choices[0].message.content
            reasoning = resp.choices[0].message.reasoning
            
            # Try content first, then reasoning
            text_to_parse = content or reasoning
            
            if not text_to_parse:
                # Try again with simpler prompt
                prompt = f'Classify: "{message[:500]}" as listing/requirement/social. Return JSON: {{"type": "...", "intent": "..."}}'
                continue

            # Try to extract JSON
            if "```json" in text_to_parse:
                text_to_parse = text_to_parse.split("```json")[1].split("```")[0].strip()
            elif "```" in text_to_parse:
                text_to_parse = text_to_parse.split("```")[1].split("```")[0].strip()

            start = text_to_parse.find("{")
            end = text_to_parse.rfind("}") + 1
            if start >= 0 and end > start:
                result = json.loads(text_to_parse[start:end])

                # Validate required fields
                if "content_type" not in result:
                    result["content_type"] = "unknown"
                if "intent" not in result:
                    result["intent"] = "NONE"
                if "confidence" not in result:
                    result["confidence"] = 0.5

                return result

        except json.JSONDecodeError:
            continue
        except Exception as e:
            if attempt == 2:  # Last attempt
                return {
                    "content_type": "unknown",
                    "intent": "NONE",
                    "confidence": 0.0,
                    "error": str(e),
                }
            continue

    # Fallback if all attempts fail
    return {
        "content_type": "unknown",
        "intent": "NONE",
        "confidence": 0.0,
    }


def classify_batch(messages: list[dict], batch_size: int = 10) -> list[dict]:
    """Classify a batch of messages.

    messages: [{"id": int, "raw_content": str}, ...]
    """
    results = []

    for i in range(0, len(messages), batch_size):
        batch = messages[i:i + batch_size]

        for msg in batch:
            classification = classify_message(msg["raw_content"])
            classification["id"] = msg["id"]
            results.append(classification)

    return results


def classify_and_store(db_path: Path, limit: int = 100) -> dict:
    """Classify unclassified knowledge records and store results."""
    db = _open_db_handle(db_path)
    if db is None:
        return {"classified": 0, "total": 0, "error": "Database not available"}

    # Get unclassified records
    rows = db.execute("""
        SELECT id, raw_content
        FROM knowledge_records
        WHERE content_type = 'unknown' AND is_valid = 1
        ORDER BY message_timestamp DESC
        LIMIT ?
    """, (limit,)).fetchall()

    if not rows:
        return {"classified": 0, "total": 0}

    messages = [{"id": r[0], "raw_content": r[1]} for r in rows]
    classifications = classify_batch(messages)

    classified = 0
    for cls in classifications:
        record_id = cls.get("id")
        if not record_id:
            continue

        try:
            # Update record
            db.execute("""
                UPDATE knowledge_records
                SET content_type = ?, intent = ?, confidence = ?,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
            """, (
                cls.get("content_type", "unknown"),
                cls.get("intent", "NONE"),
                cls.get("confidence", 0.0),
                record_id,
            ))

            # Add tags
            tags = {}
            if cls.get("building_name"):
                tags["building"] = [cls["building_name"]]
            if cls.get("market"):
                tags["market"] = [cls["market"]]
            if cls.get("bhk"):
                tags["bhk"] = [f"{cls['bhk']} BHK" if cls['bhk'] != 0.5 else "1 RK"]
            if cls.get("price"):
                tags["price"] = [str(cls["price"])]
                if cls.get("price_unit"):
                    tags["price_unit"] = [cls["price_unit"]]
            if cls.get("furnishing"):
                tags["furnishing"] = [cls["furnishing"]]
            if cls.get("property_type"):
                tags["property_type"] = [cls["property_type"]]
            if cls.get("area_sqft"):
                tags["area_sqft"] = [str(cls["area_sqft"])]
            if cls.get("tags"):
                tags["custom"] = cls["tags"]

            for tag_type, values in tags.items():
                for value in values:
                    db.execute("""
                        INSERT INTO knowledge_tags (record_id, tag_type, tag_value, confidence, source)
                        VALUES (?, ?, ?, ?, 'ai')
                    """, (record_id, tag_type, value, cls.get("confidence", 0.5)))

            classified += 1

        except Exception:
            continue

    if hasattr(db, "commit"):
        db.commit()
    if hasattr(db, "close"):
        db.close()

    return {
        "classified": classified,
        "total": len(messages),
        "classifications": classifications[:10],  # Return sample
    }


# Global instance for quick access
def classify(message: str) -> dict:
    """Quick classification of a single message."""
    return classify_message(message)
