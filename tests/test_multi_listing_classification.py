import re
from multi_listing import classify_message

def test_asterisks_bold_formatting_multi():
    """
    Test that bold asterisks surrounding building names, lines, or headers
    do not prevent a message from being classified as 'multi'.
    """
    message = (
        "*🏢 Manju Tower*\n"
        "*Rent - 45k nego*\n"
        "*1 BHK*\n"
        "-------\n"
        "*🏢 Panorama Tower*\n"
        "*Rent - 55k nego*\n"
        "*2 BHK*\n"
    )
    # This has two buildings and a divider, which matches:
    # divider_count >= 1 and building_count >= 2 -> "multi"
    assert classify_message(message) == "multi"

def test_available_bhk_in_format_multi():
    """
    Test that the pattern 'Available for rent/sale/lease <N>BHK in/at <building>'
    appearing 2+ times classifies a message as 'multi', even if prices are on
    separate lines.
    """
    message = (
        "Available for rent 1bhk in Manju Tower\n"
        "Rent - 45k nego\n"
        "Available for lease 2bhk at Panorama Tower\n"
        "Rent - 55k nego\n"
        "Available for sale 3bhk in Mayfair\n"
        "Price - 2.5 Cr\n"
    )
    # This should be classified as "multi" because the pattern appears 3 times.
    assert classify_message(message) == "multi"

def test_asterisks_available_bhk_in_combined():
    """
    Test a combined message where both bold asterisks and the 'Available for...' pattern
    are present.
    """
    message = (
        "*Available for rent 1bhk in Manju Tower*\n"
        "*Rent - 45k nego*\n"
        "*Available for rent 2bhk in Panorama Tower*\n"
        "*Rent - 55k nego*\n"
    )
    assert classify_message(message) == "multi"

if __name__ == "__main__":
    test_asterisks_bold_formatting_multi()
    test_available_bhk_in_format_multi()
    test_asterisks_available_bhk_in_combined()
    print("✅ All new multi-listing classification tests passed!")
