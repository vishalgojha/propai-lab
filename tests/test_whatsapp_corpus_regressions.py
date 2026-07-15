"""Corpus-backed regression tests for real WhatsApp export patterns.

The source material comes from the newer ZIP exports in /home/vishal/Downloads/wadata.
These tests pin the agreed parser contract on real broker messages instead of synthetic
toy strings.
"""

from app import parse_message
from multi_listing import _infer_intent_from_text, parse_multi_message


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
    assert parsed["building_name"] == "Lodha Supremus"
    assert parsed["area_sqft"] == 2742.0
    assert parsed["price"] == 15.0
    assert parsed["price_unit"] == "Lac"
    assert parsed["micro_market"] == "Worli"


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
