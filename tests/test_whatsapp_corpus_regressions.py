"""Corpus-backed regression tests for real WhatsApp export patterns.

The source material comes from the newer ZIP exports in /home/vishal/Downloads/wadata.
These tests pin the agreed parser contract on real broker messages instead of synthetic
toy strings.
"""

import evidence.resolver

from ai_chat_engine import parse_market_search_request
from app import parse_message, resolve_parsed
from location import enrich_parsed_location, parse_location


LODHA_SUPREMUS_OFFICE = """\
Available *Office Space on Lease in Worli, Dr. E. Moses Road, Upper Worli*
Building: *Lodha Supremus*
Carpet Area: *2,742 sq.ft*
Rent: *₹ 15 Lacs.*
Deposit: *6 Months Rent*
Condition: *Warmshell*

Call *Pratham Sadh* Mobile: *9920017822* - Email: pratham@realestatemumbai.com
"""


PREMIUM_OFFICE_ON_RENT = """\
🔥 *_PREMIUM OFFICE ON RENT – ANDHERI WEST_* 🔥

📍_*Citi Mall, New Link Road_*
_*(Opp. Lower Oshiwara Metro Station)_*

🔹 *1000 Sqft Carpet + 450 Sqft Mezzanine*
🔹 *15 Ft Clear Height*

💼 *_Fully Furnished | Brand New Interior_*
✔ *Spacious Reception*
✔ *1 MD Cabin (Attached Washroom)*
✔ *3 Additional Cabins*
✔ *Meeting Room*
✔️ *+ 9 Seater Conference*
✔ *24 Workstations*
✔ *Pantry + Separate Washrooms*

🚗 *_Unlimited Parking | 24 Hrs Access_*

💰 *Rent: ₹3,00,000*
💰 *_Deposit: ₹12 Lakhs_*
📃 *5 Years Lock-in Possible*

⚡ *_Possession From 1st June_*

📲 *Call/WhatsApp: 771 888 88 77*

_*(Serious Profile Required For Details)_*
"""


RESIDENTIAL_RENTAL_WITH_AVAILABILITY = """\
2 BHK on Rent
Available from 15 Aug
Semi Furnished
Rent: ₹75,000
Call/WhatsApp: 9876543210
"""


def test_lodha_supremus_office_card_parses_as_commercial():
    parsed = parse_message(LODHA_SUPREMUS_OFFICE)

    assert parsed["intent"] == "COMMERCIAL"
    assert parsed["asset_type"] == "commercial"
    assert parsed["commercial_use_type"] == "office"
    assert parsed["fitout_status"] == "warm_shell"
    assert parsed["bhk"] is None
    assert parsed["configuration"] is None
    assert parsed["building_name"] == "Lodha Supremus"
    assert parsed["area_sqft"] == 2742.0
    assert parsed["price"] == 15.0
    assert parsed["price_unit"] == "Lac"
    assert parsed["micro_market"] == "Worli"


def test_lodha_supremus_commercial_promote_labels_use_use_type():
    from routers.ai_chat import _promote_headline

    parsed = parse_message(LODHA_SUPREMUS_OFFICE)
    headline = _promote_headline(parsed, "whatsapp")
    assert "Office" in headline
    assert "BHK" not in headline


def test_premium_andheri_office_message_parses_as_one_office_card():
    parsed = parse_message(PREMIUM_OFFICE_ON_RENT)

    assert parsed["intent"] == "COMMERCIAL"
    assert parsed["area_sqft"] == 1000.0
    assert parsed["price"] == 3.0
    assert parsed["price_unit"] == "Lac"
    assert parsed["micro_market"] == "Andheri West"


def test_residential_schema_fields_are_normalized_without_blocking():
    parsed = parse_message(RESIDENTIAL_RENTAL_WITH_AVAILABILITY)

    assert parsed["asset_type"] == "residential"
    assert parsed["property_type"] == "apartment"
    assert parsed["transaction_type"] == "rent"
    assert parsed["configuration"] == "2 BHK"
    assert parsed["furnishing_canonical"] == "semi_furnished"
    assert parsed["availability_status"] == "coming_soon"
    assert parsed["available_from"] == "15 Aug"
    assert parsed["price_model"] == "total"


def test_market_chat_parser_routes_office_space_to_commercial_intent():
    parsed = parse_market_search_request("any office space on rent in bandra west?")

    assert parsed is not None
    assert parsed["intent"] == "COMMERCIAL"
    assert parsed["micro_markets"] == ["Bandra West"]


def test_known_locality_is_promoted_to_micro_market():
    location = parse_location("3 BHK for rent in Bandra West")

    assert location.locality == "Bandra West"
    assert location.micro_market == "Bandra West"


def test_location_enrichment_uses_only_unambiguous_full_message_fallback():
    enriched = enrich_parsed_location(
        {"intent": "SELL", "building_name": "Agami Eternity"},
        "Agami Eternity",
        fallback_text="3 BHK for sale in Bandra East",
    )
    ambiguous = enrich_parsed_location(
        {"intent": "BUY"},
        "Requirement",
        fallback_text="Looking in Bandra West or Khar West",
    )

    assert enriched["micro_market"] == "Bandra East"
    assert ambiguous.get("micro_market") is None


def test_primary_building_resolution_preserves_registry_micro_market(monkeypatch):
    monkeypatch.setattr(
        evidence.resolver,
        "CACHE",
        {
            "buildings": {
                "agami eternity": {
                    "building_id": 99,
                    "canonical_name": "Agami Eternity",
                    "area": "Bandra East",
                }
            }
        },
    )
    monkeypatch.setattr(evidence.resolver, "_load_registry", lambda: None)
    monkeypatch.setattr(
        evidence.resolver,
        "resolve",
        lambda *_args: (99, 0.95, "exact_name"),
    )

    resolved = resolve_parsed(
        {"building_name": "Agami Eternity", "confidence": 0.9},
        "Agami Eternity available for sale",
    )

    assert resolved["building_name"] == "Agami Eternity"
    assert resolved["micro_market"] == "Bandra East"
