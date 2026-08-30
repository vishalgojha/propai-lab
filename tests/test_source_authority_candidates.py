from copy import deepcopy

from extraction import (
    _ai_extraction_to_typed,
    _apply_listing_transaction_guard,
    _apply_source_evidence_gates,
    _ground_locality_to_source,
)
from extraction_quality import apply_price_sanity_guard
from source_authority import evaluate_source_authority
from source_authority_candidates import (
    bhk_candidates,
    furnishing_candidate,
    locality_candidate,
    produce_source_candidates,
    psf_price_candidate,
    resolver_candidate,
    route_candidate,
)


def test_route_adapter_matches_legacy_route_for_same_input_without_mutation():
    source = "Available 2 BHK for rent"
    original = {"listing_type": "requirement"}
    legacy = _apply_listing_transaction_guard([original], source, [source])[0]
    candidates = produce_source_candidates(original, source)
    assert legacy["listing_type"] == "requirement"
    assert candidates["listing_type"].candidate_value == "rent"
    assert original == {"listing_type": "requirement"}


def test_requirement_adapter_reports_evidence_but_does_not_rewrite_ai():
    source = "URGENT REQUIREMENT: client needs a 2 BHK"
    ai = {"listing_type": "sale"}
    before = deepcopy(ai)
    result = evaluate_source_authority(ai, source, source_candidates={"listing_type": route_candidate(source)})
    assert result.values["listing_type"] == "requirement"
    assert ai["listing_type"] == "sale"
    assert ai == before


def test_bhk_adapter_matches_existing_source_regex_shape():
    source = "2 BHK in Bandra"
    candidate = bhk_candidates(source)[0]
    assert candidate.candidate_value == 2.0
    assert source[candidate.source_span[0]:candidate.source_span[1]] == "2"


def test_multi_unit_adapter_exposes_count_and_bhk_separately():
    candidates = {item.field: item for item in bhk_candidates("4 x 2 BHK")}
    assert candidates["listing_count"].candidate_value == 4
    assert candidates["bhk"].candidate_value == 2.0


def test_psf_adapter_matches_legacy_parser_without_price_rewrite():
    source = "Rate 2500 per sqft"
    ai = {"price": {"amount": 1000}}
    legacy = apply_price_sanity_guard(ai, source)
    candidate = psf_price_candidate(source)
    assert candidate.candidate_value == 2500.0
    assert legacy["price"]["amount"] == 1000
    assert ai["price"]["amount"] == 1000


def test_psf_candidate_can_be_reviewed_without_quarantining_ai_price():
    source = "Rate 2500 per sqft"
    ai = {"price_per_sqft": 1000}
    result = evaluate_source_authority(ai, source, source_candidates={"price_per_sqft": psf_price_candidate(source)})
    assert result.values["price_per_sqft"] == 2500.0


def test_furnishing_adapter_has_no_candidate_when_legacy_guard_would_clear():
    source = "2 BHK Bandra"
    assert furnishing_candidate(source) is None


def test_furnishing_candidate_is_explicit_and_span_backed():
    source = "Fully Furnished 2 BHK"
    candidate = furnishing_candidate(source)
    assert candidate.candidate_value == "fully_furnished"
    assert source[candidate.source_span[0]:candidate.source_span[1]] == "Fully Furnished"


def test_locality_adapter_does_not_upgrade_contextual_text():
    source = "Close to a landmark"
    assert locality_candidate(source) is None


def test_locality_adapter_is_item_scoped():
    source = "Location: Bandra West"
    candidate = locality_candidate(source, source_slice_id="item-a")
    assert candidate.candidate_value == "Bandra West"
    assert candidate.source_slice_id == "item-a"


def test_building_resolver_adapter_preserves_provenance():
    source = "Lodha Sea View, Bandra"
    candidate = resolver_candidate(
        "building_name", "Lodha Sea View", source,
        rule_id="building.alias.exact", confidence=0.96,
        explicit=True, unique=True,
    )
    assert candidate.source_span == (0, len("Lodha Sea View"))
    assert candidate.rule_id == "building.alias.exact"


def test_candidate_collection_does_not_mutate_ai_payload():
    ai = {"listing_type": "sale", "building_name": "AI Tower", "price": 100}
    before = deepcopy(ai)
    candidates = produce_source_candidates(ai, "For Sale 2 BHK, Rate 2500 per sqft")
    assert candidates["listing_type"].candidate_value == "sale"
    assert ai == before


def test_candidate_slice_mismatch_is_left_for_authority_to_review():
    source = "Location: Bandra West"
    candidate = locality_candidate(source, source_slice_id="item-b")
    result = evaluate_source_authority(
        {"locality": "Bandra East"}, source,
        source_candidates={"locality": candidate},
        context={"source_slice_id": "item-a"},
    )
    assert result.values["locality"] == "Bandra East"
    assert result.needs_review


def test_source_boundary_gate_legacy_output_is_not_adapter_output():
    source = "For Rent 2 BHK"
    ai = {"listing_type": "requirement", "bhk": 3}
    legacy = _apply_source_evidence_gates(ai, source)
    candidates = produce_source_candidates(ai, source)
    assert legacy["listing_type"] == "requirement"
    assert candidates["listing_type"].candidate_value == "rent"
    assert ai["listing_type"] == "requirement"


def test_locality_legacy_mutation_does_not_run_in_candidate_collection():
    source = "Bandra West"
    ai = {"locality": None, "building_name": "Bandra West"}
    before = deepcopy(ai)
    _ground_locality_to_source(ai, source)
    candidate = locality_candidate("Location: Bandra West")
    assert candidate.candidate_value == "Bandra West"
    assert before["building_name"] == "Bandra West"


def test_typed_path_projects_only_a_strong_source_route_correction():
    source = "Available 2 BHK for rent in Bandra"
    table, row = _ai_extraction_to_typed(
        {"listing_type": "sale", "bhk": 2}, source, slice_text=source
    )
    assert table == "residential_rent_listings"
    assert row["bhk"] == 2.0
    decision = evaluate_source_authority(
        {"listing_type": "sale"}, source,
        source_candidates=produce_source_candidates({}, source),
    ).decisions[0]
    assert decision.action == "correct_from_source"


def test_typed_path_preserves_ai_when_no_unambiguous_route_candidate_exists():
    source = "2 BHK for rent / sale"
    table, row = _ai_extraction_to_typed(
        {"listing_type": "sale", "bhk": 2}, source, slice_text=source
    )
    assert table == "residential_sale_listings"
    assert row["bhk"] == 2.0
    result = evaluate_source_authority(
        {"listing_type": "sale"}, source,
        source_candidates=produce_source_candidates({}, source),
    )
    assert not result.needs_review
    assert result.decisions[0].ai_value_preserved
