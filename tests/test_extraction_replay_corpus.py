from scripts.build_extraction_replay_corpus import build_cases, flag_families, format_families


def test_format_families_describes_shape_without_extracting_facts():
    labels = format_families("*3 BHK FOR RENT*\n2.5L/month\n================")
    assert "bullet_or_bold_fields" in labels
    assert "separator_blocks" in labels
    assert "configuration_cue" in labels
    assert "price_shorthand" in labels


def test_flag_families_are_explicit_and_overlapping():
    labels = flag_families(["missing_price", "title_evidence_mismatch"])
    assert labels == ["title_grounding", "price_grounding"]


def test_build_cases_is_keyed_by_raw_and_listing_index_and_keeps_expected_empty():
    rows = [
        {
            "id": 11,
            "raw_message_id": 7,
            "listing_index": 2,
            "validation_flags": ["missing_price"],
            "needs_review": True,
            "transaction_type": "rent",
            "building_name": "Example Tower",
            "locality_resolved": "Bandra West",
            "price_raw_text": "2.5L",
            "ai_extraction": {"bhk": 3, "source_slice": "3 BHK 2.5L"},
            "raw_payload": {},
            "_table": "residential_rent_listings",
            "_price_column": "monthly_rent",
        },
        # Same observation returned by another quality family must not create
        # a duplicate evaluation case.
        {
            "id": 11,
            "raw_message_id": 7,
            "listing_index": 2,
            "validation_flags": ["missing_price"],
            "needs_review": True,
            "transaction_type": "rent",
            "building_name": "Example Tower",
            "locality_resolved": "Bandra West",
            "price_raw_text": "2.5L",
            "ai_extraction": {"bhk": 3, "source_slice": "3 BHK 2.5L"},
            "raw_payload": {},
            "_table": "residential_rent_listings",
            "_price_column": "monthly_rent",
        },
    ]
    raw = {
        7: {
            "id": 7,
            "tenant_id": "tenant-a",
            "message": "3 BHK for rent in Bandra West at 2.5L",
            "message_type": "text",
            "source": "WHATSAPP",
            "group_name": "Broker group",
            "timestamp": "2026-09-10T00:00:00Z",
            "raw_payload": {},
        }
    }
    cases = build_cases(rows, raw, sample_size=10, seed=1)
    assert len(cases) == 1
    assert cases[0]["case_id"] == "7:2"
    assert cases[0]["expected"] is None
    assert cases[0]["observed"]["fields"]["source_slice"] == "3 BHK 2.5L"
