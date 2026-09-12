from extraction_quality import canonicalize_extraction_confidence


def test_pipeline_review_preserves_model_confidence_separately():
    result = canonicalize_extraction_confidence({
        "extraction_confidence_score": 0.9,
        "needs_review": True,
        "validation_flags": ["building_name_unresolved"],
    })
    assert result["model_confidence"] == 0.9
    assert result["pipeline_review"] is True
    assert result["pipeline_review_reasons"] == ["building_name_unresolved"]
    assert result["extraction_confidence_score"] == 0.6
