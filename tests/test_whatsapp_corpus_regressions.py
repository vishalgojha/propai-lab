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


def _find_card(cards: list[dict], **criteria) -> dict:
    for card in cards:
        if all(card.get(key) == value for key, value in criteria.items()):
            return card
    raise AssertionError(f"No card matched criteria: {criteria!r}")


def test_lodha_supremus_office_card_parses_as_commercial():
    parsed = parse_message(LODHA_SUPREMUS_OFFICE)

    assert parsed["intent"] == "COMMERCIAL"
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

    assert len(cards) == 5

    omkar_3bhk = _find_card(cards, bhk="3 BHK")
    assert omkar_3bhk["area_sqft"] == 1930.0

    omkar_5bhk = _find_card(cards, bhk="5 BHK")
    assert omkar_5bhk["area_sqft"] == 5650.0

    monte_430 = _find_card(cards, price=4.3, price_unit="Cr")
    monte_455 = _find_card(cards, price=4.55, price_unit="Cr")
    assert monte_430 != monte_455
