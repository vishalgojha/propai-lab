"""Corpus-backed regression tests for real WhatsApp export patterns.

The source material comes from the newer ZIP exports in /home/vishal/Downloads/wadata.
These tests pin the agreed parser contract on real broker messages instead of synthetic
toy strings.
"""

import evidence.resolver

from app import parse_message, resolve_parsed
from location import enrich_parsed_location, parse_location
from multi_listing import _infer_intent_from_text, _lines_to_listings, parse_multi_message


LODHA_SUPREMUS_OFFICE = """\
Available *Office Space on Lease in Worli, Dr. E. Moses Road, Upper Worli*
Building: *Lodha Supremus*
Carpet Area: *2,742 sq.ft*
Rent: *₹ 15 Lacs.*
Deposit: *6 Months Rent*
Condition: *Warmshell*

Call *Pratham Sadh* Mobile: *9920017822* - Email: pratham@realestatemumbai.com
"""


COMMERCIAL_REQUIREMENT = """\
Requirement for L&L Rental- Commercial
Locations- Mahalaxmi, Lower Parel, Worli
Building- Prestige Turf Tower, Marathon Futurex, Lodha Supremus
Carpet- 3000-3500 sq.ft.
Budget- As per Market

Only Direct Listings please. No +1.

Contact:
Pratham Sadh – 9920017822
Sandeep Sadh – 9820030685
"""


OMKAR_AND_MONTE_MULTI = """\
*Outrate Option @Omkar 1973 Worli*

3 bhk - 1930sqft
Bareshell
Price -11.50 cr
Negotiable

5 BHK- 5650 sqft
Bareshell
Price - 36.50 cr negotiable

Jaria properties
8652620372
*AVAILABLE FOR Outrate @Monte South*

2BHK
Builder finished
Higher floor
4.30cr

2BHK
Builder finished
Higher floor
4.55cr

Jaria properties
8652620372
"""


BARUDGAR_PROPERTIES_MULTI = """\
*AVAILABLE 2 BHK FOR SALE IN TARDEO*

BLDG : *AARTI*
OPP. AC MKT, TARDEO ROAD.
AREA : 752 SQFT CARPET.
CAR PARK : 🚘
*O.C. : ✅*
*@ 4.25 CR NEGOTIABLE.*

*BROKERAGE SBS ONLY*
*YOGESH BAJAJ/9870008644*
*AVAILABLE A 3 BHK FOR SALE*

BLDG : *CHANDAN WISTERIA*
D.B.CROSS ROAD, VILE PARLE WEST.
AREA : 870 RERA CARPET
HIGHER FLOOR.
CAR PARK : 🚘
AMENITIES : GYM & GAMES ROOM
*O.C. : ✅*
*@ 3.65 CR + + NEGOTIABLE.*

*BROKERAGE SBS ONLY*
*YOGESH BAJAJ/9870008644*
*AVAILABLE 3 BHK ON SALE*

BLDG : *PARMAR*
HANUMAN ROAD,VILE PARLE EAST
MIDDLE FLOOR
AREA : 925 SQFT
CAR PARK : 🚘
*O.C.:  ✅*
*@ 3.75 CR NEGOTIABLE.*

*BROKERAGE SBS ONLY*
*YOGESH BAJAJ/9870008644*
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


AGAMI_ETERNITY_OPTIONS = """\
✨ 3 BHK FOR SALE | BANDRA EAST | AGAMI ETERNITY ✨
🏢 Agami Eternity
🏡 Option 1
📐 940 Sq. Ft. Carpet
🚗 1 Car Parking
💰 ₹5.50 Cr
🏡 Option 2
📐 1,061 Sq. Ft. Carpet + Deck
💰 ₹6.29 Cr
📞 Advait Makhija
Dreams2Realty
📱 +91 9833223040
"""


def _find_card(cards: list[dict], **criteria) -> dict:
    for card in cards:
        if all(card.get(key) == value for key, value in criteria.items()):
            return card
    raise AssertionError(f"No card matched criteria: {criteria!r}")


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
    from app import _promote_headline

    parsed = parse_message(LODHA_SUPREMUS_OFFICE)
    headline = _promote_headline(parsed, "whatsapp")
    assert "Office" in headline
    assert "BHK" not in headline


def test_requirement_messages_stay_requirement_first():
    assert _infer_intent_from_text(COMMERCIAL_REQUIREMENT) == "BUY"

    parsed = parse_message(COMMERCIAL_REQUIREMENT)
    assert parsed["intent"] == "BUY"
    assert parsed["principal"] == "Buyer Client"
    assert parsed["area_sqft"] == 3500.0
    assert parsed["location_raw"] == "Lower Parel"


def test_multi_option_broadcast_splits_into_multiple_cards():
    cards = parse_multi_message(OMKAR_AND_MONTE_MULTI)

    assert len(cards) == 4

    omkar_3bhk = _find_card(cards, bhk="3 BHK")
    assert omkar_3bhk["area_sqft"] == 1930.0
    assert omkar_3bhk["price"] == 11.5
    assert omkar_3bhk["price_unit"] == "Cr"

    omkar_5bhk = _find_card(cards, bhk="5 BHK")
    assert omkar_5bhk["area_sqft"] == 5650.0
    assert omkar_5bhk["price"] == 36.5
    assert omkar_5bhk["price_unit"] == "Cr"

    monte_430 = _find_card(cards, price=4.3, price_unit="Cr")
    monte_455 = _find_card(cards, price=4.55, price_unit="Cr")
    assert monte_430 != monte_455


def test_explicit_option_markers_produce_complete_alternative_cards():
    cards = parse_multi_message(AGAMI_ETERNITY_OPTIONS)

    assert len(cards) == 2
    option_1 = _find_card(cards, area_sqft=940.0, price=5.5, price_unit="Cr")
    option_2 = _find_card(cards, area_sqft=1061.0, price=6.29, price_unit="Cr")
    for card in (option_1, option_2):
        assert card["bhk"] == "3 BHK"
        assert card["building_name"] == "Agami Eternity"
        assert card["broker_phone"] == "9833223040"


def test_barudgar_properties_multi_forward_keeps_all_three_cards():
    cards = parse_multi_message(BARUDGAR_PROPERTIES_MULTI)

    assert len(cards) == 3
    assert _find_card(cards, price=4.25, price_unit="Cr")["area_sqft"] == 752.0
    assert _find_card(cards, price=3.65, price_unit="Cr")["area_sqft"] == 870.0
    assert _find_card(cards, price=3.75, price_unit="Cr")["area_sqft"] == 925.0
    for card in cards:
        assert card["broker_phone"] == "9870008644"


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


def test_generic_multi_listing_lines_emit_canonical_intent():
    cards = _lines_to_listings(
        "3 BHK | 1200 sqft | 5 Cr",
        section_intent=None,
        section_furnish=None,
        shared_building=None,
        profile_name=None,
    )

    assert len(cards) == 1
    assert cards[0]["intent"] == "SELL"


def test_compact_numbered_inventory_splits_and_cleans_buildings():
    message = """1 Bhk Raheja Estate Kulupwadi Near National Park 40k/ 1 Lac Furnished
1 Bhk Ariana Residency 31k/1 Lac Unfurnished
2 Bhk Maruti Tower Thakur Complex 57k/2 Lac Furnished
2 Bhk Espee Tower 67k/2.5 Lac Furnished
2 Bhk Triumph Siddhivinayak 60k/2 Lac Unfurnished
2.5 Bhk Samarpan Tower 77k/3 Lac Final Fully furnished
3 Bhk Viceroy Savana 1.10 Lac Unfurnished
3 Bhk Samarpan Exotica 93k/3 Lac Furnished"""

    cards = parse_multi_message(message, profile_name="Manish Yadav")

    assert len(cards) == 8
    assert cards[0]["bhk"] == "1 BHK"
    assert cards[0]["building_name"] == "Raheja Estate Kulupwadi Near National Park"
    assert cards[0]["price"] == 40
    assert cards[0]["price_unit"] == "K"
    assert cards[1]["building_name"] == "Ariana Residency"
    assert cards[1]["furnishing"] == "Unfurnished"


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
