from agents.building_enrichment.crawl_discovery import score_discovery


def test_discovery_scores_name_and_locality_evidence():
    name, locality = score_discovery(
        "Gurudev Bhavan",
        "Khar West",
        "K-73, Gurudev Bhavan, 17th Road, Khar West, Mumbai",
    )
    assert name == 1.0
    assert locality == 1.0


def test_discovery_does_not_treat_unrelated_page_as_candidate():
    name, locality = score_discovery(
        "By Apartment",
        "Worli Naka",
        "Apartment Road, Worli, Mumbai, rental listings",
    )
    assert name == 0.0
    assert locality < 1.0
