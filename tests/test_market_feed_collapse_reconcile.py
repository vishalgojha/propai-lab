from storage.supabase import _collapse_intra_message_rows


def _row(**overrides):
    base = {
        "raw_message_id": "1825351",
        "observation_type": "LISTING",
        "building_name": "Kanakia Paris",
        "locality_resolved": "Bandra East",
        "transaction_type": "sale",
        "summary_title": "",
    }
    base.update(overrides)
    return base


def test_collapse_resolves_majority_transaction_and_backfills_price():
    rows = [
        _row(
            transaction_type="rent",
            summary_title="Apartment for rent in Kanakia Paris, Bandra East",
        ),
        _row(
            summary_title="Large 2 BHK For Sale",
            bhk=2,
        ),
        _row(
            summary_title="Apartment for sale in Kanakia Paris (2 units)",
        ),
        _row(
            summary_title="3.40 CR Onwards Property",
            price=34000000.0,
            total_asking_price=34000000.0,
            price_raw_text="3.40 crs onwards respectively",
        ),
    ]

    collapsed = _collapse_intra_message_rows(rows)

    assert len(collapsed) == 1
    card = collapsed[0]
    assert card["variant_count"] == 4
    assert card["transaction_type"] == "sale"
    assert card["intent"] == "SELL"
    assert card["price"] == 34000000.0
    assert card["price_raw_text"] == "3.40 crs onwards respectively"
    assert card["monthly_rent"] is None
    assert card["bhk"] == 2
    assert card["summary_title"] == "Apartment for sale in Kanakia Paris (2 units)"


def test_collapse_keeps_a_rent_rate_on_a_rent_message():
    rows = [
        _row(transaction_type="rent", summary_title="2 BHK for rent", monthly_rent=400000.0),
        _row(transaction_type="rent", summary_title="Rent Bandra East"),
        _row(transaction_type="sale", summary_title="stray sale fragment", total_asking_price=1.0),
    ]

    collapsed = _collapse_intra_message_rows(rows)

    assert len(collapsed) == 1
    card = collapsed[0]
    assert card["transaction_type"] == "rent"
    assert card["intent"] == "RENT"
    assert card["monthly_rent"] == 400000.0


def test_collapse_leaves_a_single_row_untouched():
    rows = [_row(transaction_type="sale", summary_title="Only row", price=100.0)]
    collapsed = _collapse_intra_message_rows(rows)
    assert collapsed == rows
