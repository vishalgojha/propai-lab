from source_authority import SourceEvidence, evaluate_source_authority


def evidence(field, value, source, *, rule="test.explicit", confidence=0.95, explicit=True, unique=True, slice_id=None):
    start = source.index(str(value))
    return SourceEvidence(field, value, (start, start + len(str(value))), rule, confidence, explicit, unique, slice_id)


def decision(result, field):
    return next(item for item in result.decisions if item.field == field)


def test_no_match_never_changes_nonempty_ai_value():
    result = evaluate_source_authority({"building_name": "Lodha Sea View"}, "1 BHK available", source_candidates={})
    assert result.values["building_name"] == "Lodha Sea View"
    assert decision(result, "building_name").action == "trust_ai"


def test_low_confidence_conflict_preserves_ai():
    source = "Building: Lodha Sea View / Other Tower"
    result = evaluate_source_authority(
        {"building_name": "Lodha Sea View"}, source,
        source_candidates={"building_name": evidence("building_name", "Other Tower", source, confidence=0.4)},
        field_confidence={"building_name": 0.5},
    )
    assert result.values["building_name"] == "Lodha Sea View"
    assert result.needs_review


def test_generic_title_never_replaces_specific_ai_title():
    source = "For Sale"
    result = evaluate_source_authority(
        {"summary_title": "3 BHK Lodha Sea View at ₹2 Cr"}, source,
        source_candidates={"summary_title": evidence("summary_title", "For Sale", source)},
    )
    assert result.values["summary_title"] == "3 BHK Lodha Sea View at ₹2 Cr"


def test_unknown_transaction_type_never_defaults_to_sale():
    result = evaluate_source_authority({"transaction_type": "UNKNOWN"}, "Property details pending")
    assert result.values["transaction_type"] == "UNKNOWN"
    assert result.values["transaction_type"] != "SALE"


def test_missing_building_evidence_does_not_clear_ai_building():
    result = evaluate_source_authority({"building_name": "Lodha Sea View"}, "Near Bandra station")
    assert result.values["building_name"] == "Lodha Sea View"


def test_missing_furnishing_evidence_does_not_delete_ai_value():
    result = evaluate_source_authority({"furnishing": "Fully Furnished"}, "2 BHK, Bandra")
    assert result.values["furnishing"] == "Fully Furnished"


def test_candidate_from_another_slice_cannot_correct_value():
    source = "Item A: Lodha Sea View"
    result = evaluate_source_authority(
        {"building_name": "AI Building"}, source,
        source_candidates={"building_name": evidence("building_name", "Lodha Sea View", source, slice_id="item-b")},
        context={"source_slice_id": "item-a"},
    )
    assert result.values["building_name"] == "AI Building"
    assert "source_candidate_crossed_item_slice" in decision(result, "building_name").reasons


def test_source_correction_records_rule_and_span():
    source = "Price 2 Cr"
    result = evaluate_source_authority(
        {"price": 1}, source,
        source_candidates={"price": evidence("price", 2, source, rule="price.explicit.cr")},
    )
    # The synthetic span intentionally points at the numeric token; the rule
    # and span are preserved even when the candidate's textual representation
    # is numeric.
    assert decision(result, "price").evidence.rule_id == "price.explicit.cr"
    assert result.provenance["field_decisions"]["price"]["source_span"] is not None


def test_corrected_value_retains_original_ai_in_provenance():
    source = "Rent 90000"
    result = evaluate_source_authority(
        {"price": 100000}, source,
        source_candidates={"price": evidence("price", 90000, source)},
    )
    assert result.values["price"] == 90000
    assert result.provenance["ai_values"]["price"] == 100000


def test_validation_hold_does_not_mutate_extraction_truth():
    result = evaluate_source_authority(
        {"price": 100000}, "Price unclear",
        source_candidates={"price": SourceEvidence("price", 200000, None, "price.ambiguous", 0.4, False, False)},
    )
    assert result.values["price"] == 100000
    assert result.needs_review


def test_result_is_immutable_from_input_mutation():
    ai = {"bhk": "2 BHK"}
    result = evaluate_source_authority(ai, "2 BHK available")
    ai["bhk"] = "4 BHK"
    assert result.values["bhk"] == "2 BHK"


def test_read_time_projection_contract_has_no_semantic_rewrite():
    result = evaluate_source_authority({"summary_title": "3 BHK Lodha"}, "3 BHK Lodha")
    assert result.values == {"summary_title": "3 BHK Lodha"}
    assert result.provenance["field_decisions"]["summary_title"]["action"] == "trust_ai"


def test_every_decision_is_inspectable():
    result = evaluate_source_authority({"price": 2000000, "bhk": "2 BHK"}, "2 BHK, ₹20 L")
    assert {item.field for item in result.decisions} == {"price", "bhk"}
    assert set(result.provenance["field_decisions"]) == {"price", "bhk"}


def test_one_call_evaluates_all_fields_together():
    source = "Lodha Sea View, Price 2 Cr"
    result = evaluate_source_authority(
        {"building_name": "AI Building", "price": 1}, source,
        source_candidates={
            "building_name": evidence("building_name", "Lodha Sea View", source),
            "price": evidence("price", 2, source),
        },
    )
    assert len(result.decisions) == 2


def test_no_independent_mutation_occurs_for_weak_candidate():
    source = "Maybe around Bandra"
    original = {"locality": "Bandra West"}
    result = evaluate_source_authority(
        original, source,
        source_candidates={"locality": SourceEvidence("locality", "Bandra", None, "locality.fuzzy", 0.2, False, False)},
    )
    assert result.values["locality"] == "Bandra West"
    assert original == {"locality": "Bandra West"}
