import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from deterministic_splitters import parse_chunk, parse_message


INLINE_BOLD_REPRO = """*Available Bandra West Brand new building*
*Crescent* 3bhk 1342 sqft pali hill price 12.12cr
*Parishram* 4bhk - 2046 sqft carpet hiegher floor sea view pali hill price 31.32cr
bandra west *New brand building* *Penthouse*
5188sqft carpet with sea facing pali hill price 76.8cr bandra west
*Available for sale 2Bhk* Building Name: *Pioneer Heights* (khar West)
Flat is of 950 carpet approx With 1 Car Parking Floor:2nd
Total floors in Building:14
Amenities in building: Gym,Play Room
Price 3.70cr Kindly Call
Sunil - contact
Mahi - contact"""


def test_inline_bold_broadcast_splits_four_sale_listings():
    pattern_id, chunks = parse_message(INLINE_BOLD_REPRO)

    assert pattern_id == "inline_bold_header"
    assert len(chunks) == 4
    assert [chunk["building_name"] for chunk in chunks] == [
        "Crescent", "Parishram", "Penthouse", "Pioneer Heights"
    ]
    assert [chunk["bhk"] for chunk in chunks] == ["3 BHK", "4 BHK", None, "2 BHK"]
    assert [chunk["price"] for chunk in chunks] == [12.12, 31.32, 76.8, 3.7]
    assert [chunk["price_unit"] for chunk in chunks] == ["cr"] * 4
    assert [chunk["intent"] for chunk in chunks] == ["SELL"] * 4
    assert all("Brand new building" in chunk["raw_payload"]["full_text"] for chunk in chunks)


def test_numbered_template_splits_into_three_chunks():
    text = """1. A Wing
3 BHK
1500 carpet
5.25 Cr

2. B Wing
4 BHK
1800 carpet
6.25 Cr

3. C Wing
2 BHK
900 carpet
2.5 Cr"""

    pattern_id, chunks = parse_message(text)

    assert pattern_id == "numbered"
    assert len(chunks) == 3
    assert [chunk["bhk"] for chunk in chunks] == ["3 BHK", "4 BHK", "2 BHK"]
    assert [chunk["price_unit"] for chunk in chunks] == ["cr", "cr", "cr"]


def test_slash_numbered_broadcast_splits_properties_and_clear_office_section():
    text = """*Available 2bhk 3Bhk On Sale in Bandra*
1/ New Building untouched apt
Location Nea East Around The Corner Bandra West
Carpet Area 655
Car park 1
Asking 4'50cr Nego
Inspection Any Time open for All
PCs Available

2/ *2Bhk with Balconys Available For lease or Sale*
Carpet Area 1050 with 1car park
Location madhu park Khar West
Asking Rent 185k Negotiable
Sale 5.50cr Nego PCs available
Inspection 1 day Notice

3/ *2Bhk Available in Beaupride*
Carpet Area 890 with Balcony
Car par 3 very good building in Bandra good interior with Amenities
Open view Distance Sea
Higher Floor Asking 5'65Cr Negotiable

4/ *3Bhk Available in Bandra*
Carpet Area 1200 one stilt Big Carpar
can park 2 Car Building Parthana Apt
Near Gold Gym Pali Naka Asking 6Cr Negotiable

*Office Available For Sale*
Commercial Glass Facade Building
Carpet Area 700 with 1Car parking
Location 16th Road Bandra Near Mini Punjab Building Roha Orion
photos Available"""

    pattern_id, chunks = parse_message(text)

    assert pattern_id == "numbered"
    assert len(chunks) == 5
    assert "Beaupride" in chunks[2]["raw_payload"]["slice_text"]
    assert "Office Available For Sale" in chunks[4]["raw_payload"]["slice_text"]
    assert "Office Available For Sale" not in chunks[3]["raw_payload"]["slice_text"]


def test_markdown_numbered_headings_keep_building_and_locality_per_slice():
    text = """*1. IndiaBulls Blu – Worli*
• 4 BHK
• 1,700 Sq. Ft. Carpet Area
• Fully Furnished
• Rent: ₹7.50 Lakhs/month

*2. Meher Apartment – Altamount Road*
• 2 BHK
• 1,120 Sq. Ft.
• Rent: ₹3.25 Lakhs/month

*3. Vardhman – Kemps Corner*
• 1 BHK
• 650 Sq. Ft.
• Rent: ₹1 Lakh/month"""

    pattern_id, chunks = parse_message(text)

    assert pattern_id == "numbered"
    assert len(chunks) == 3
    assert [chunk["building_name"] for chunk in chunks] == [
        "IndiaBulls Blu", "Meher Apartment", "Vardhman"
    ]
    assert [chunk["location_raw"] for chunk in chunks] == [
        "Worli", "Altamount Road", "Kemps Corner"
    ]


def test_labelled_bildg_is_extracted_as_building():
    text = """*Avail 2 BHK flat for Rent*
Location : *Lalbag*
*Bildg : Vardhaman Estate*
*Condition : Unfurnished*
*M. Rent : 1 Lakh*"""

    parsed = parse_chunk(text)

    assert parsed["building_name"] == "Vardhaman Estate"
    assert parsed["location_raw"] == "Lalbag"


def test_dash_separator_template_splits_into_two_chunks():
    text = """*3 BHK*
Rustomjee Paramount
24th floor
1350 sqft
semi furnished
5.25 Cr
──────────
*4 BHK*
Rustomjee Paramount
17th floor
1800 sqft
fully furnished
6.25 Cr"""

    pattern_id, chunks = parse_message(text)

    assert pattern_id == "dash_separator"
    assert len(chunks) == 2
    assert chunks[0]["bhk"] == "3 BHK"
    assert chunks[1]["bhk"] == "4 BHK"
    assert chunks[0]["furnishing"] == "semi_furnished"


def test_independent_building_broadcast_does_not_leak_first_block_into_second():
    text = """*🟡GURUKIRPA REALTORS MUMBAI | NEW ARRIVALS*

*INDEPENDENT BUILDING AVAILABLE ON RENT**

*⚪Area – 3 Lakhs sqft*
▪ 10 Floors Building
▪ 30,000 sqft Each Floor
▪ A+ Grade Building
▪ Ground Floor Parking
▪ Rent – ₹6 Cr (₹200 psf)
▪ Saki Naka, Near Airport
▪ Andheri East

────────────

*⚪Charming Standalone Property*
▪ 1300 sq.ft
▪ Ground +1
▪ +800 sqft Terrace
▪ +500 sqft Open Space
▪ Surrounded By Lush Greenery
▪ Rent: ₹8 Lakhs
▪ Pali Hill, Bandra West"""

    pattern_id, chunks = parse_message(text)

    assert pattern_id == "dash_separator"
    assert len(chunks) == 2
    assert "Saki Naka" in chunks[0]["raw_payload"]["slice_text"]
    assert "Charming Standalone Property" in chunks[1]["raw_payload"]["slice_text"]
    assert "Saki Naka" not in chunks[1]["raw_payload"]["slice_text"]


def test_emoji_bullet_template_splits_into_two_chunks():
    text = """🏡 2 BHK in BKC
Tower A
1200 sqft
85 L

🏡 3 BHK in BKC
Tower B
1500 sqft
1.25 Cr"""

    pattern_id, chunks = parse_message(text)

    assert pattern_id == "emoji_bullet"
    assert len(chunks) == 2
    assert chunks[0]["bhk"] == "2 BHK"
    assert chunks[1]["price_unit"] == "cr"


def test_bare_bhk_template_splits_without_separators():
    text = """3 BHK
Rustomjee Paramount
1350 carpet
5.25 Cr
4 BHK
Rustomjee Paramount
1800 carpet
6.25 Cr"""

    pattern_id, chunks = parse_message(text)

    assert pattern_id == "bare_bhk_header"
    assert len(chunks) == 2
    assert [chunk["bhk"] for chunk in chunks] == ["3 BHK", "4 BHK"]


def test_bare_bhk_mixed_sections_attach_next_heading_to_next_property():
    text = """*6 ORVA – BANDRA WEST*
*2 BHK + 2 BHK JODI → 4 BHK*
Exclusive Fully Furnished
Rent: ₹4,00,000/- Slightly Negotiable
Deposit: 4 Months Rent

* COMMERCIAL RENTAL*
*JUHU VERSOVA LINK ROAD – NEAR JUHU CIRCLE*
2 BHK | Ground Floor
Carpet Area: 700 Sq. Ft.
Rent: ₹95,000/-

* SALE PROPERTIES*
*1 HURTOWN PREMIER – SEVEN BUNGALOWS*
4 BHK
Price: ₹8 Cr"""

    pattern_id, chunks = parse_message(text)

    assert pattern_id == "bare_bhk_header"
    assert len(chunks) == 3
    assert "SALE PROPERTIES" not in chunks[0]["raw_payload"]["slice_text"]
    assert "SALE PROPERTIES" not in chunks[1]["raw_payload"]["slice_text"]
    assert "COMMERCIAL RENTAL" in chunks[1]["raw_payload"]["slice_text"]
    assert "SALE PROPERTIES" in chunks[2]["raw_payload"]["slice_text"]
    assert [chunk["intent"] for chunk in chunks] == ["RENT", "RENT", "SELL"]


def test_run_on_inventory_splits_only_when_each_listing_has_a_price():
    text = (
        "Large One Bhk Sf Flat Chimbai Rd Partial Seaview Flat Second floor no Lift Asking 75 K "
        "2 Bhk Sf Flat Amrit Bldg Carter Rd Pet Friendly Society Rent 40 K Neg "
        "Studio Sf Expat Quality Chimbai Rd Asking 35 K Ist Floor Open View"
    )

    pattern_id, chunks = parse_message(text)

    assert pattern_id == "run_on_inventory"
    assert len(chunks) == 3
    assert [chunk["price"] for chunk in chunks] == [75.0, 40.0, 35.0]
    assert all("raw_payload" in chunk for chunk in chunks)


def test_run_on_configuration_range_is_not_split_into_fake_listings():
    text = "Need 2 BHK or 3 BHK in Bandra West, budget 75 K, family tenant only"

    pattern_id, chunks = parse_message(text)

    assert pattern_id is None
    assert chunks == []


def test_bare_bhk_accepts_house_emoji_between_marker_and_configuration():
    text = """*🏡 2 BHK for Rent*
Matai Mansion
1200 sqft
85 L
*🏡3Bhk's*
Another Mansion
1400 sqft
95 L"""

    pattern_id, chunks = parse_message(text, preferred_pattern="bare_bhk_header")

    assert pattern_id == "bare_bhk_header"
    assert len(chunks) == 2
    assert [chunk["bhk"] for chunk in chunks] == ["2 BHK", "3 BHK"]


def test_pushpin_bullet_template_splits_into_two_chunks():
    text = """RESIDENTIAL LEASE LISTINGS
📍 Rustomjee Paramount
2 BHK
85 L
📍 Another Mansion
3 BHK
1.25 Cr"""

    pattern_id, chunks = parse_message(text)

    assert pattern_id == "emoji_bullet"
    assert len(chunks) == 2
    assert [chunk["bhk"] for chunk in chunks] == ["2 BHK", "3 BHK"]


def test_shared_bhk_header_is_inherited_but_never_becomes_a_listing():
    text = """_UPDATED 3BHK OUTRIGHT LIST_
📍 Rustomjee Crown, Prabhadevi
1350 sqft
8.5 Cr
📍 NCPA, Nariman Point
2880 sqft
40 Cr"""

    pattern_id, chunks = parse_message(text)

    assert pattern_id == "emoji_bullet"
    assert len(chunks) == 2
    assert [chunk["bhk"] for chunk in chunks] == ["3 BHK", "3 BHK"]
    assert all("UPDATED 3BHK OUTRIGHT LIST" in chunk["raw_payload"]["full_text"] for chunk in chunks)


def test_markdown_wrapped_house_and_pushpin_markers_are_structural():
    text = """_🏡Matai Mansion_
_📍John Baptist Road Bandra_
_2 BHK_
85 L
_🏡Another Mansion_
_📍Hill Road Bandra_
_3 BHK_
1.25 Cr"""

    pattern_id, chunks = parse_message(text, preferred_pattern="bare_bhk_header")

    assert pattern_id == "bare_bhk_header"
    assert len(chunks) == 2
    assert [chunk["bhk"] for chunk in chunks] == ["2 BHK", "3 BHK"]


def test_real_emoji_bullet_broadcast_keeps_missing_bullet_anchor_as_its_own_chunk():
    text = """🔑 RESIDENTIAL LEASE LISTINGS
━━━━━━━━━━━━━━━━━

📍 Andheri West – Vandana Building
(Near Kokilaben Hospital)
• 3 BHK | 1200 Sq.ft
• Fully Furnished
• 1 Parking
• Ample Storage
• 1 Km from DN Nagar Metro
💰 Rent: ₹1.20 Lac
💰 Deposit: ₹5 Lac
Only for family

📍 Andheri East – Brindaban ?Poonam Nagar
• 3 BHK Fully Furnished
• 1 Parking
• Immediate Possession
💰 Rent: ₹1.20 Lac
💰 Deposit: ₹3 Lac
Only for family

Andheri West – HDIL Metropolis
• 3 BHK Semi Furnished
• Approx. 1400 Sq.ft
• 28th Floor
• Full Sunlight & Open View
• 3 Bathrooms + Helper’s Bathroom
• Balconies in Hall, Kitchen & Bedrooms
• 2 Car Parks
💰 Rent: ₹2.10 Lac (Negotiable)
✅ Pure Veg Families Only

📍 Andheri West – Prime Rose Tower
(Azad Nagar, Veera Desai Road)
• 3 BHK Semi Furnished
• 1300 Carpet
• Immediate Possession
💰 Rent: ₹1.20 Lac
💰 Deposit: 3 Months"""

    pattern_id, chunks = parse_message(text)

    assert pattern_id == "emoji_bullet"
    assert len(chunks) == 4
    assert chunks[0]["building_name"] == "Andheri West – Vandana Building"
    assert chunks[1]["building_name"].startswith("Andheri East")
    assert "HDIL Metropolis" not in chunks[1]["building_name"]
    assert chunks[2]["building_name"] == "HDIL Metropolis"
    assert chunks[2]["location_raw"] == "Andheri West"
    assert chunks[3]["building_name"].startswith("Andheri West – Prime Rose Tower")


def test_real_dash_separated_anchor_line_populates_building_and_location():
    text = """🔑 PREMIUM RESIDENTIAL LEASE LISTINGS
━━━━━━━━━━━━━━━━━━
📍 Andheri West – Raheja Classic
• 3 BHK Lavish Fully Furnished Apartment
• 1150 Sq.ft Carpet
• 1 Parking
• Lower Floor
• Internal Garden View
💰 Rent: ₹1.85 Lac (Final)

📍 Andheri West – HDIL Metropolis
• 3 BHK Semi Furnished Apartment
• Approx. 1400 Sq.ft
• 28th Floor
• Full Sunlight & Open View
• 3 Bathrooms + Helper’s Bathroom
• Balconies in Hall, Kitchen & Bedrooms
• 2 Car Parks
💰 Rent: ₹2.10 Lac for family
For Bachelor-2.25 lac
✅ Pure Veg Families Only"""

    pattern_id, chunks = parse_message(text)

    assert pattern_id == "emoji_bullet"
    assert len(chunks) == 2
    assert chunks[0]["building_name"] == "Raheja Classic"
    assert chunks[0]["location_raw"] == "Andheri West"
    assert chunks[1]["building_name"] == "HDIL Metropolis"
    assert chunks[1]["location_raw"] == "Andheri West"


def test_real_611019_third_listing_keeps_full_location_line():
    text = """*🏡 2 BHK for Rent*
Hill Dream, Pali Mala Road, Bandra (West)
📐 Carpet Area: 750 sq. ft.
🚗 Parking: 1
🛋️ Condition: Semi Furnished
💰 Rent: ₹1.80 Lac

*📞 For Inspection & More Details:*
👤 Rajesh: 9920098794
👤 Nandu: 9869489519
📱 9619133319

*2 BHK for Rent*
👉 Building: Bajaj Jade
👉 Location: Union Park, Bandra (West)
👉 Carpet : 850 Sq.Ft.
👉 Condition : Fully Furnished
👉 Rent : 2.50 Lac

*📞 For More Details*
👤 Rajesh 9920098794
👤 Nandu : 9869489549
📱 9619133319

*3 BHK for Rent*
👉 Location : Near Almeida Park, Bandra (West)
👉 Carpet : 1000 Sq.Ft.
👉 Condition: Semi Furnished
👉 Parking : 1
👉 Rent : 1.85 Lac"""

    pattern_id, chunks = parse_message(text)

    assert pattern_id == "bare_bhk_header"
    assert len(chunks) == 3
    assert chunks[2]["building_name"] is None
    assert "Near Almeida Park, Bandra (West)" in chunks[2]["location_raw"]


def test_separator_keeps_second_listing_without_bhk_header():
    text = """4 BHK PENTHOUSE
Semi Furnished, 2 Car Parks
Rent - 12.50 Lacs
______
SUKHMANI – NEAR KAFE AZMI PARK, JUHU
Higher Floor
Terrace Flat
Semi Furnished | 2 Car Parks
Rent - 4.00 Lacs"""

    pattern_id, chunks = parse_message(text)

    assert pattern_id == "dash_separator"
    assert len(chunks) == 2
    assert "SUKHMANI" in chunks[1]["normalized_message"]


def test_bunglow_heading_stops_bare_bhk_slice():
    text = """5.5 BHK with Terrace For SALE
Building Name: 3rd Road Khar West
Asking: 9.50 Cr

BUNGLOW FOR SALE
KHANDALA
AREA: 3400 SQ.FT G+1 DECK
ASKING: 4.50 Cr Nego"""

    pattern_id, chunks = parse_message(text)

    assert pattern_id == "bare_bhk_header"
    assert len(chunks) == 2
    assert "BUNGLOW FOR SALE" in chunks[1]["raw_payload"]["full_text"]
