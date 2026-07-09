"""
Seed messages for Local Intelligence Lab.

Realistic WhatsApp messages with expected ground truth for parser evaluation.
Run:  python3 -m lab.seed

Format: { "message": str, "expected": dict | None }
"""
import sys
from pathlib import Path

PROJECT_DIR = Path(__file__).parent.parent
sys.path.insert(0, str(PROJECT_DIR))

SEED_MESSAGES = [
    # ── Seller messages ────────────────────────────────────
    {
        "message": "3 BHK in Lodha Belvedere, Worli. 4.5 Cr. Fully furnished. Contact Vishal 9876543210",
        "expected": {
            "message_type": "SELLER",
            "bhk": "3 BHK",
            "price": 45000000,
            "price_unit": "Cr",
            "furnishing": "Fully Furnished",
            "building_name": "Lodha Belvedere",
            "area": "Worli",
            "broker_name": "Vishal",
            "broker_phone": "9876543210",
        },
    },
    {
        "message": "2 BHK for sale near Lilavati Hospital. 2.8 Cr. Semi furnished. Call Rakesh 8765432109",
        "expected": {
            "message_type": "SELLER",
            "bhk": "2 BHK",
            "price": 2800000,
            "price_unit": "Cr",
            "furnishing": "Semi Furnished",
            "landmark_name": "Lilavati Hospital",
            "broker_name": "Rakesh",
            "broker_phone": "8765432109",
        },
    },
    {
        "message": "1 BHK available opposite Mehboob Studio. 1200 sqft. Unfurnished. Price 1.2 Cr. Contact 7654321098",
        "expected": {
            "message_type": "SELLER",
            "bhk": "1 BHK",
            "area_sqft": 1200,
            "furnishing": "Unfurnished",
            "landmark_name": "Mehboob Studio",
            "price": 1200000,
            "price_unit": "Cr",
        },
    },
    {
        "message": "Direct owner 2 BHK at High Street Phoenix area. 3.1 Cr. Fully furnished. Call 9876512345",
        "expected": {
            "message_type": "SELLER",
            "bhk": "2 BHK",
            "price": 3100000,
            "price_unit": "Cr",
            "furnishing": "Fully Furnished",
            "landmark_name": "High Street Phoenix",
        },
    },
    # ── Buyer messages ────────────────────────────────────
    {
        "message": "WANTED: 3 BHK in Bandra West near Mount Mary. Budget 5 Cr. Need fully furnished. Call Amit 9988776655",
        "expected": {
            "message_type": "BUYER",
            "bhk": "3 BHK",
            "price": 50000000,
            "price_unit": "Cr",
            "furnishing": "Fully Furnished",
            "landmark_name": "Mount Mary",
            "broker_name": "Amit",
            "broker_phone": "9988776655",
        },
    },
    {
        "message": "Looking for 2 BHK near Linking Road. Budget 2.5 Cr. Semi furnished. Contact 8877665544",
        "expected": {
            "message_type": "BUYER",
            "bhk": "2 BHK",
            "price": 2500000,
            "price_unit": "Cr",
            "furnishing": "Semi Furnished",
            "landmark_name": "Linking Road",
        },
    },
    # ── Rental messages ────────────────────────────────────
    {
        "message": "1 BHK for rent near BKC. 45k per month. Fully furnished. Call Deepak 7766554433",
        "expected": {
            "message_type": "RENTAL",
            "bhk": "1 BHK",
            "price": 45000,
            "furnishing": "Fully Furnished",
            "landmark_name": "BKC",
            "broker_name": "Deepak",
        },
    },
    {
        "message": "Rent: 2 BHK behind Mount Mary Church. 65k. Semi furnished. Contact 6655443322",
        "expected": {
            "message_type": "RENTAL",
            "bhk": "2 BHK",
            "price": 65000,
            "furnishing": "Semi Furnished",
            "landmark_name": "Mount Mary Church",
        },
    },
    # ── Station references ────────────────────────────────
    {
        "message": "3 BHK walking distance from Bandra Station. 1500 sqft. 3.8 Cr. Call 5544332211",
        "expected": {
            "message_type": "SELLER",
            "bhk": "3 BHK",
            "area_sqft": 1500,
            "price": 3800000,
            "price_unit": "Cr",
            "landmark_name": "Bandra Station",
        },
    },
    {
        "message": "Studio apartment near Khar Station. 35k rent. Fully furnished. Contact 4433221100",
        "expected": {
            "message_type": "RENTAL",
            "bhk": "Studio",
            "price": 35000,
            "furnishing": "Fully Furnished",
            "landmark_name": "Khar Station",
        },
    },
    # ── Edge cases ─────────────────────────────────────────
    {
        "message": "1 RK near Juhu Circle. 25k. Semi furnished. Call 3322110099",
        "expected": {
            "message_type": "RENTAL",
            "bhk": "1 BHK",  # RK ≈ BHK
            "price": 25000,
            "furnishing": "Semi Furnished",
            "landmark_name": "Juhu Circle",
        },
    },
    {
        "message": "Plot for sale in Oshiwara. 2000 sqft. Price 2 Cr. Contact 2211009988",
        "expected": {
            "message_type": "SELLER",
            "area_sqft": 2000,
            "price": 20000000,
            "price_unit": "Cr",
            "area": "Oshiwara",
        },
    },
    {
        "message": "Commercial shop opposite Infinity Mall. 500 sqft. Rent 50k. Call 1100998877",
        "expected": {
            "message_type": "COMMERCIAL_RENTAL",
            "area_sqft": 500,
            "price": 50000,
            "landmark_name": "Infinity Mall",
        },
    },
    # ── Landmark aliases ──────────────────────────────────
    {
        "message": "2 BHK opp. Lilavati. 1800 sqft. 4.2 Cr. Fully furnished. Contact Mahesh 9988771122",
        "expected": {
            "message_type": "SELLER",
            "bhk": "2 BHK",
            "area_sqft": 1800,
            "price": 4200000,
            "price_unit": "Cr",
            "furnishing": "Fully Furnished",
            "landmark_name": "Lilavati Hospital",
            "broker_name": "Mahesh",
        },
    },
]


def seed(api_url: str = "http://localhost:8000"):
    """POST seed messages to the lab API."""
    import httpx
    import time

    results = {"total": 0, "resolved": 0, "unresolved": 0, "errors": 0}
    for i, item in enumerate(SEED_MESSAGES):
        try:
            r = httpx.post(
                f"{api_url}/ingest",
                json={
                    "message": item["message"],
                    "group": "seed",
                    "sender": "seed-bot",
                    "expected": item.get("expected"),
                },
                timeout=10,
            )
            data = r.json()
            status = "✓" if data.get("resolver", {}).get("building_id") else "✗"
            if status == "✓":
                results["resolved"] += 1
            else:
                results["unresolved"] += 1
            print(f"  {status}  [{i+1:>2}/{len(SEED_MESSAGES)}] {item['message'][:60]:<60}")
            results["total"] += 1
        except Exception as e:
            results["errors"] += 1
            print(f"  ✗  [{i+1:>2}/{len(SEED_MESSAGES)}] ERROR: {e}")

    print()
    print(f"  Seeded {results['total']} messages")
    print(f"  Resolved:   {results['resolved']}")
    print(f"  Unresolved: {results['unresolved']}")
    print(f"  Errors:     {results['errors']}")

    if results["errors"] == 0 and results["unresolved"] < results["total"]:
        print(f"\n  Admin UI: {api_url}/")


if __name__ == "__main__":
    import sys
    api_url = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8000"
    print(f"Seeding {len(SEED_MESSAGES)} messages to {api_url}...\n")
    seed(api_url)
