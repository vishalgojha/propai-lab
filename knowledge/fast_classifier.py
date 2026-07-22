"""
Fast hybrid classifier for knowledge records.
Uses rules for obvious cases, AI only for ambiguous ones.
"""

import re
import os
from pathlib import Path


# Market names (common Mumbai localities)
MARKETS = {
    'bandra', 'andheri', 'santacruz', 'khar', 'juhu', 'goregaon', 'malad',
    'worli', 'powai', 'bkc', 'lokhandwala', 'versova', 'vile parle', 'vileparle',
    'kurla', 'ghatkopar', 'mulund', 'thane', 'vashi', 'nerul', 'belapur',
    'kharghar', 'seawoods', 'panvel', 'ulwe', 'taloja', 'kasarvadavali',
    'mumbra', 'diva', 'kopar khairane', 'sanpada', 'auromatrix',
    'dadar', 'parel', 'matunga', 'mahim', 'wadala', 'sion', 'chembur',
    'govandi', 'mankhurd', 'virar', 'vasai', 'nalla sopara', 'boisar',
    'dahisar', 'borivali', 'kandivali', 'charkop', 'evershine',
    'marve', 'malvani', 'okhla', 'jamia', 'saket', 'vasant kunj',
    'dwarka', 'rohini', 'pitampura', 'shakarpur', 'laxmi nagar',
}

# Building suffixes
BUILDING_SUFFIXES = [
    'building', 'bldg', 'bil', 'apt', 'apartment', 'complex', 'tower',
    'heights', 'height', 'park', 'residency', 'enclave', 'villa',
    'society', 'chs', 'housing', 'residences', 'nest', 'abode',
    'haven', 'vihar', 'vatika', 'gardens', 'groves', 'court',
    'house', 'mansion', 'lodge', 'retreat', 'arcade', 'plaza',
    'center', 'centre', 'quarters', 'chambers', 'house', 'annexe',
]

# Intent keywords
SELL_KEYWORDS = ['for sale', 'for sell', 'outright', 'sale', 'selling', 'available for sale']
RENT_KEYWORDS = ['for rent', 'for lease', 'rental', 'rent', 'lease', 'leased', 'on rent']
BUY_KEYWORDS = ['looking for', 'want to buy', 'need', 'seeking', 'searching', 'required']
RENTAL_SEEK_KEYWORDS = ['looking for rent', 'need on rent', 'want on rent', 'seeking rental']

# BHK patterns
BHK_PATTERN = re.compile(r'(\d+(?:\.\d+)?)\s*(?:bhk|bhk\b|rk\b|rk\b)', re.IGNORECASE)

# Price patterns
PRICE_CR_PATTERN = re.compile(r'(\d+(?:\.\d+)?)\s*(?:cr|crore|crores)', re.IGNORECASE)
PRICE_L_PATTERN = re.compile(r'(\d+(?:\.\d+)?)\s*(?:l|lac|lakh|lakhs)', re.IGNORECASE)
PRICE_K_PATTERN = re.compile(r'(\d+(?:\.\d+)?)\s*(?:k|thousand)', re.IGNORECASE)
PRICE_NUM_PATTERN = re.compile(r'(?:rs|inr|₹)\s*(\d+(?:,\d+)*(?:\.\d+)?)', re.IGNORECASE)

# Furnishing
FURNISHING_MAP = {
    'fully furnished': 'FULLY_FURNISHED',
    'fully-furnished': 'FULLY_FURNISHED',
    'furnished': 'FULLY_FURNISHED',
    'semi furnished': 'SEMI_FURNISHED',
    'semi-furnished': 'SEMI_FURNISHED',
    'semifurnished': 'SEMI_FURNISHED',
    'unfurnished': 'UNFURNISHED',
    'un furnished': 'UNFURNISHED',
    'bare shell': 'UNFURNISHED',
}


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


def classify_rule_based(message: str) -> dict:
    """Fast rule-based classification."""
    text = message.lower().strip()

    result = {
        'content_type': 'unknown',
        'intent': 'NONE',
        'building_name': None,
        'market': None,
        'bhk': None,
        'price': None,
        'price_unit': None,
        'furnishing': None,
        'confidence': 0.5,
    }

    # Check if it's a real estate message
    is_real_estate = False

    # Detect intent
    if any(kw in text for kw in SELL_KEYWORDS):
        result['intent'] = 'SELL'
        result['content_type'] = 'listing'
        is_real_estate = True
    elif any(kw in text for kw in RENT_KEYWORDS):
        result['intent'] = 'RENT'
        result['content_type'] = 'listing'
        is_real_estate = True
    elif any(kw in text for kw in RENTAL_SEEK_KEYWORDS):
        result['intent'] = 'RENTAL_SEEKER'
        result['content_type'] = 'requirement'
        is_real_estate = True
    elif any(kw in text for kw in BUY_KEYWORDS):
        result['intent'] = 'BUY'
        result['content_type'] = 'requirement'
        is_real_estate = True

    # If no intent detected, check for real estate indicators
    if not is_real_estate:
        re_indicators = ['bhk', 'flat', 'apartment', 'rent', 'sale', 'sqft', 'sq ft',
                        'carpet', 'built up', 'super built', 'furnishing', 'broker']
        if any(ind in text for ind in re_indicators):
            is_real_estate = True
            # Guess intent from context
            if any(w in text for w in ['available', 'offer', 'deal', 'price']):
                result['intent'] = 'SELL'
                result['content_type'] = 'listing'

    # Extract BHK
    bhk_match = BHK_PATTERN.search(text)
    if bhk_match:
        bhk_val = float(bhk_match.group(1))
        result['bhk'] = bhk_val
        result['confidence'] = max(result['confidence'], 0.7)

    # Extract price
    price_match = PRICE_CR_PATTERN.search(text)
    if price_match:
        result['price'] = float(price_match.group(1)) * 10000000
        result['price_unit'] = 'CR'
        result['confidence'] = max(result['confidence'], 0.7)
    else:
        price_match = PRICE_L_PATTERN.search(text)
        if price_match:
            result['price'] = float(price_match.group(1)) * 100000
            result['price_unit'] = 'L'
            result['confidence'] = max(result['confidence'], 0.7)
        else:
            price_match = PRICE_K_PATTERN.search(text)
            if price_match:
                result['price'] = float(price_match.group(1)) * 1000
                result['price_unit'] = None
                result['confidence'] = max(result['confidence'], 0.7)

    # Extract market
    for market in MARKETS:
        if market in text:
            result['market'] = market.title()
            result['confidence'] = max(result['confidence'], 0.8)
            break

    # Extract building name
    for suffix in BUILDING_SUFFIXES:
        pattern = re.compile(rf'\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\s+{suffix}\b', re.IGNORECASE)
        match = pattern.search(message)
        if match:
            result['building_name'] = match.group(1)
            result['confidence'] = max(result['confidence'], 0.8)
            break

    # Extract furnishing
    for key, value in FURNISHING_MAP.items():
        if key in text:
            result['furnishing'] = value
            result['confidence'] = max(result['confidence'], 0.7)
            break

    # If we detected real estate but no intent, mark as social/notification
    if is_real_estate and result['intent'] == 'NONE':
        if any(w in text for w in ['notification', 'alert', 'update', 'info']):
            result['content_type'] = 'notification'
        else:
            result['content_type'] = 'inquiry'
    elif not is_real_estate:
        # Check if it's clearly social
        social_indicators = ['hello', 'hi', 'thanks', 'thank you', 'good morning',
                           'good evening', 'how are you', 'bye', 'ok', 'sure']
        if any(ind in text for ind in social_indicators):
            result['content_type'] = 'social'
            result['confidence'] = 0.3
        else:
            result['content_type'] = 'unknown'
            result['confidence'] = 0.2

    return result


def classify_all(db_path: Path, batch_size: int = 1000):
    """Classify all knowledge records using rules."""
    db = _open_db_handle(db_path)
    if db is None:
        return {"error": "Database not available"}

    # Get unclassified records
    rows = db.execute("""
        SELECT id, raw_content
        FROM knowledge_records
        WHERE content_type = 'unknown' AND COALESCE(is_valid, true) = true
    """).fetchall()

    print(f"Classifying {len(rows)} records...")

    count = 0
    stats = {'listing': 0, 'requirement': 0, 'social': 0, 'unknown': 0, 'notification': 0, 'inquiry': 0}

    for i, row in enumerate(rows):
        record_id = row[0]
        message = row[1] or ""

        result = classify_rule_based(message)

        # Update record
        db.execute("""
            UPDATE knowledge_records
            SET content_type = ?, intent = ?, confidence = ?,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        """, (
            result['content_type'],
            result['intent'],
            result['confidence'],
            record_id,
        ))

        # Add tags
        tags = {}
        if result['building_name']:
            tags['building'] = [result['building_name']]
        if result['market']:
            tags['market'] = [result['market']]
        if result['bhk']:
            tags['bhk'] = [f"{result['bhk']} BHK" if result['bhk'] != 0.5 else "1 RK"]
        if result['price']:
            tags['price'] = [str(result['price'])]
            if result['price_unit']:
                tags['price_unit'] = [result['price_unit']]
        if result['furnishing']:
            tags['furnishing'] = [result['furnishing']]

        for tag_type, values in tags.items():
            for value in values:
                db.execute("""
                    INSERT INTO knowledge_tags (record_id, tag_type, tag_value, confidence, source)
                    VALUES (?, ?, ?, ?, 'rules')
                """, (record_id, tag_type, value, result['confidence']))

        stats[result['content_type']] = stats.get(result['content_type'], 0) + 1
        count += 1

        if (i + 1) % 5000 == 0:
            print(f"  Classified {i + 1}/{len(rows)}...")
            db.commit()

    if hasattr(db, "commit"):
        db.commit()
    db.close()

    print(f"\nClassification complete: {count} records")
    print("\nBreakdown:")
    for k, v in sorted(stats.items(), key=lambda x: -x[1]):
        print(f"  {k}: {v}")

    return stats


if __name__ == "__main__":
    supabase_url = os.getenv("SUPABASE_URL", "")
    supabase_key = os.getenv("SUPABASE_SERVICE_KEY", "")
    if not supabase_url or not supabase_key:
        raise SystemExit("Supabase is required. Set SUPABASE_URL and SUPABASE_SERVICE_KEY.")
    from storage import SupabaseStorage

    db_path = SupabaseStorage(supabase_url, supabase_key).db
    classify_all(db_path)
