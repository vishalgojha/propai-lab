"""
Regression tests for REQUIREMENT vs LISTING classification bug.

Tests that requirement-indicating language is prioritized over listing-shape fields
when classifying messages.
"""

import re
from multi_listing import _infer_intent_from_text


def test_requirement_keywords_before_listing_shape_fields():
    """
    Test that requirement keywords are checked BEFORE listing-shape fields.
    
    Bug: Messages with "Require..." were being classified as LISTING because
    the intent classifier checked for "rent" in "Rental Budget" before checking
    for "require" keyword.
    
    Fix: Check requirement keywords FIRST in _infer_intent_from_text.
    """
    # Test case from the bug report
    gymnasium_msg = (
        "Require 5000 to 8000sq.ft Carpet Area for a Celebrity Brand "
        "Gymnasium in and around Andheri Link Road (Infinity Mall, Citimall/ "
        "Fun Republic Lane) / Veera Desai Road/ Lokhandwala and Oshiwara. "
        "Rental Budget:- Approx 8 to 10 lacs."
    )
    
    intent = _infer_intent_from_text(gymnasium_msg)
    assert intent == "BUY", f"Expected 'BUY' but got '{intent}' for requirement message with listing-shape fields"
    
    # Additional test cases with different requirement phrasings
    test_cases = [
        ("I need a 3BHK in Bandra West", "BUY"),
        ("Looking for office space in BKC", "BUY"),
        ("Client wants 2000 sqft shop in Andheri East", "BUY"),
        ("Wanted: 1500 sqft apartment near Lokhandwala", "BUY"),
        ("In search of a 4BHK in Juhu", "BUY"),
        ("Seeking commercial property in Powai", "BUY"),
        ("Requirement: 5000 sqft gym space in Andheri Link Road", "BUY"),
        ("Need rental space 8-10 lacs budget", "BUY"),
        # Requirement with price/area/location should still be REQUIREMENT
        ("Require 2BHK in Andheri West for 1.5 lacs rent", "BUY"),
        ("Looking for 3000 sqft in BKC, budget 2.5 cr", "BUY"),
    ]
    
    for msg, expected_intent in test_cases:
        intent = _infer_intent_from_text(msg)
        assert intent == expected_intent, (
            f"Message: {msg[:100]}...\n"
            f"Expected intent '{expected_intent}' but got '{intent}'"
        )


def test_listing_shape_fields_do_not_override_requirement():
    """
    Test that listing-shape fields (price, sqft, location) don't cause
    requirement messages to be misclassified as LISTING.
    """
    # Message with "Require" + listing fields
    msg1 = "Require 3BHK in Bandra West, 1500 sqft, budget 2.5 cr"
    intent1 = _infer_intent_from_text(msg1)
    assert intent1 == "BUY", f"Expected BUY but got {intent1}"
    
    # Message with "Looking for" + listing fields
    msg2 = "Looking for 2BHK in Andheri East, 1000 sqft carpet, rent 1 lac"
    intent2 = _infer_intent_from_text(msg2)
    assert intent2 == "BUY", f"Expected BUY but got {intent2}"
    
    # Message with "Need" + listing fields
    msg3 = "Need 5000 sqft shop in BKC, budget 8-10 lacs"
    intent3 = _infer_intent_from_text(msg3)
    assert intent3 == "BUY", f"Expected BUY but got {intent3}"


def test_requirement_keywords_variations():
    """Test various requirement keyword variations."""
    variations = [
        "require",
        "Require",
        "REQUIRE",
        "requirement",
        "Requirement",
        "requirements",
        "looking for",
        "Looking for",
        "need",
        "Need",
        "wanted",
        "Wanted",
        "in search of",
        "In search of",
        "client wants",
        "Client wants",
        "enquiry for",
        "Enquiry for",
        "seeking",
        "Seeking",
        "searching for",
        "Searching for",
    ]
    
    for keyword in variations:
        msg = f"{keyword} 3BHK in Andheri West"
        intent = _infer_intent_from_text(msg)
        assert intent == "BUY", f"Keyword '{keyword}' should result in BUY intent, got {intent}"


def test_listing_keywords_still_work():
    """Ensure listing keywords still work correctly."""
    listing_cases = [
        ("3BHK in Bandra West for sale", "SELL"),
        ("2BHK in Andheri East for rent", "RENT"),
        ("Apartment for sale in Juhu", "SELL"),
        ("Office space for rent in BKC", "COMMERCIAL"),  # Office = commercial property
        ("Ready to move 3BHK", "SELL"),
        ("Lease commercial property", "COMMERCIAL"),
        ("Shop for rent in Andheri", "COMMERCIAL"),
        ("Warehouse for sale", "COMMERCIAL"),
        ("Retail space available", "COMMERCIAL"),
    ]
    
    for msg, expected in listing_cases:
        intent = _infer_intent_from_text(msg)
        assert intent == expected, f"Message: {msg[:80]}... Expected {expected} but got {intent}"


if __name__ == "__main__":
    test_requirement_keywords_before_listing_shape_fields()
    test_listing_shape_fields_do_not_override_requirement()
    test_requirement_keywords_variations()
    test_listing_keywords_still_work()
    print("✅ All requirement classification tests passed!")
