import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from deterministic_splitters import parse_message


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
