from agents.building_enrichment.crawl_discovery import extract_result_urls, rendered_page_text, score_discovery
from agents.building_enrichment.discovery import BuildingDiscovery
from agents.building_enrichment.providers import source_locality_conflict
from agents.building_enrichment.structured_extraction import extract_structured_fields
from storage.supabase import _locality_contains_known_slug
from location import parse_location


def test_building_identity_reuses_noisy_locality_context_only_when_contained():
    assert _locality_contains_known_slug(
        "bandra-west", "near-lilavati-hospital-reclamation-bandra-west-fully-furnished"
    ) is True
    assert _locality_contains_known_slug("bandra-west", "bandra-east") is False
    assert _locality_contains_known_slug("bandra", "bandra-west") is False


def test_noisy_whatsapp_locality_resolves_before_building_identity_key():
    assert parse_location(
        "Near Lilavati Hospital, Reclamation, Bandra West Fully Furnished"
    ).micro_market == "Bandra West"


def test_discovery_scores_name_and_locality_evidence():
    name, locality = score_discovery(
        "Gurudev Bhavan",
        "Khar West",
        "K-73, Gurudev Bhavan, 17th Road, Khar West, Mumbai",
    )
    assert name == 1.0
    assert locality == 1.0


def test_discovery_rejects_locality_as_building_name():
    discovery = BuildingDiscovery(storage=None)

    assert discovery._is_valid_building_name("Pali Hill") is False
    assert discovery._is_valid_building_name("Pali Hill Niketan") is True


def test_discovery_does_not_treat_unrelated_page_as_candidate():
    name, locality = score_discovery(
        "By Apartment",
        "Worli Naka",
        "Apartment Road, Worli, Mumbai, rental listings",
    )
    assert name == 0.0
    assert locality < 1.0


def test_enrichment_context_prefers_source_and_rejects_conflicts():
    evidence = {"source_localities": {"Lower Parel": 11, "Andheri East": 2}}

    assert source_locality_conflict(evidence, {"micro_market": "Lower Parel"}) is None
    assert source_locality_conflict(evidence, {"micro_market": "Andheri East"}) is not None


def test_enrichment_context_blocks_ambiguous_name_without_auto_apply():
    evidence = {"source_localities": {"Lower Parel": 6, "Andheri East": 5}}

    assert source_locality_conflict(evidence, {}) is not None


def test_discovery_ignores_building_name_in_source_url():
    name, _ = score_discovery(
        "Gurudev Bhavan",
        "",
        "Search Project https://example.gov/projects?project_name=Gurudev%20Bhavan&project_state=27",
    )
    assert name == 0.0


def test_structured_extraction_requires_explicit_claims():
    fields = extract_structured_fields(
        "Monalisa Apartments",
        "Address: 12 Example Road, Bandra West, Mumbai\n"
        "Developer: Example Homes\n"
        "MahaRERA No: P51800012345\n"
        "Amenities: Lift, gym and parking\n"
        "Latitude: 19.0596 Longitude: 72.8295",
    )
    assert fields["address"]["value"].startswith("12 Example Road")
    assert fields["developer"]["value"] == "Example Homes"
    assert fields["rera_number"]["value"] == "P51800012345"
    assert "gym" in fields["amenities"]["value"]
    assert fields["latitude"]["value"] == 19.0596


def test_structured_extraction_does_not_infer_missing_fields():
    assert extract_structured_fields("Monalisa Apartments", "Bandra West, Mumbai") == {}


def test_structured_extraction_reads_labelled_claims_from_flattened_search_text():
    fields = extract_structured_fields(
        "Trinity Luxury Residences Khar West Mumbai",
        "Property Overview Address: 139, 10th Road, Khar West, Mumbai. Residential apartments.",
    )

    assert fields["address"]["value"] == "139, 10th Road, Khar West, Mumbai"


def test_extract_result_urls_filters_google_and_bounds_links():
    class Result:
        links = {
            "external": [
                {"href": "https://www.google.com/search?q=ignored"},
                {"href": "https://example.com/building"},
                {"href": "https://developer.example.com/project"},
                {"href": "https://third.example.com/extra"},
            ]
        }

    assert extract_result_urls(Result(), limit=2) == [
        "https://example.com/building",
        "https://developer.example.com/project",
    ]


def test_extract_result_urls_falls_back_to_google_redirects_in_markdown():
    class Result:
        links = {}
        markdown = "[Project](https://www.google.com/url?q=https%3A%2F%2Fexample.com%2Fproject)"

    assert extract_result_urls(Result()) == ["https://example.com/project"]


def test_extract_result_urls_falls_back_to_rendered_html():
    class Result:
        links = {}
        markdown = ""
        html = '<a href="https://www.google.com/url?q=https%3A%2F%2Fexample.com%2Fproject">Project</a>'

    assert extract_result_urls(Result()) == ["https://example.com/project"]


def test_extract_result_urls_resolves_relative_google_redirects():
    class Result:
        links = {"results": [{"href": "/url?sa=t&url=https%3A%2F%2Fexample.com%2Fproject"}]}

    assert extract_result_urls(Result()) == ["https://example.com/project"]


def test_extract_result_urls_checks_crawl4ai_fit_html():
    class Result:
        links = {}
        fit_html = '<a href="/url?q=https%3A%2F%2Fexample.com%2Fproject">Project</a>'

    assert extract_result_urls(Result()) == ["https://example.com/project"]


def test_extract_result_urls_blocks_bing_search_pages():
    class Result:
        links = [
            {"href": "https://www.bing.com/search?q=other"},
            {"href": "http://www.w3.org/1999/xhtml"},
            {"href": "https://schemas.live.com/Web/"},
            {"href": "https://example.com/project"},
        ]

    assert extract_result_urls(Result()) == ["https://example.com/project"]


def test_rendered_page_text_uses_crawl4ai_alternate_markdown_fields():
    class Result:
        markdown = ""
        fit_markdown = "Developer: Example Homes"
        raw_markdown = ""
        cleaned_html = "<p>Address: 12 Example Road</p>"

    text = rendered_page_text(Result())
    assert "Developer: Example Homes" in text
    assert "Address: 12 Example Road" in text


def test_extract_result_urls_strips_search_citation_markup():
    class Result:
        links = [{"href": "https://example.com/project</cite>"}]

    assert extract_result_urls(Result()) == ["https://example.com/project"]


def test_extract_result_urls_prioritizes_bing_result_cards():
    class Result:
        links = [
            {"href": "https://www.techspot.com"},
            {"href": "https://en.wikipedia.org"},
        ]
        html = (
            '<li class="b_algo"><h2><a href="https://property.example/project">'
            'Kalpataru Magnus</a></h2></li>'
        )

    assert extract_result_urls(Result()) == ["https://property.example/project", "https://www.techspot.com", "https://en.wikipedia.org"]


def test_extract_result_urls_filters_result_cards_by_query_text():
    class Result:
        links = [{"href": "https://www.tiktok.com"}]
        html = (
            '<li class="b_algo"><h2><a href="https://noise.example">'
            'Trending video</a></h2></li>'
            '<li class="b_algo"><h2><a href="https://property.example/girnar">'
            'Girnar Pali Hill apartments</a></h2></li>'
        )

    assert extract_result_urls(Result(), query_text="Girnar Pali Hill Mumbai") == [
        "https://property.example/girnar"
    ]


def test_extract_result_urls_falls_back_to_query_matched_rendered_anchors():
    class Result:
        links = [{"href": "https://www.tiktok.com"}]
        html = (
            '<a href="https://noise.example">Trending video</a>'
            '<a href="https://property.example/trinity">Trinity Luxury Residences Khar West</a>'
        )

    assert extract_result_urls(Result(), query_text="Trinity Khar West Mumbai") == [
        "https://property.example/trinity"
    ]


def test_extract_result_urls_falls_back_to_query_matched_markdown_links():
    class Result:
        links = [{"href": "https://www.tiktok.com"}]
        markdown = (
            "[Trending video](https://noise.example) "
            "[Girnar Pali Hill apartments](https://property.example/girnar)"
        )

    assert extract_result_urls(Result(), query_text="Girnar Pali Hill Mumbai") == [
        "https://property.example/girnar"
    ]


def test_extract_result_urls_uses_safe_url_fallback_when_only_hrefs_exist():
    class Result:
        links = [
            {"href": "https://www.tiktok.com"},
            {"href": "https://www.magicbricks.com/trinity-luxury-residences"},
        ]
        markdown = "Trinity Luxury Residences in Khar West Mumbai"

    assert extract_result_urls(Result(), query_text="Trinity Khar West Mumbai") == [
        "https://www.magicbricks.com/trinity-luxury-residences"
    ]


def test_trinity_is_not_rejected_as_a_name_label():
    from extraction_quality import building_name_problem

    assert building_name_problem("Name- Trinity", locality="Khar West") is None


def test_building_name_validation_rejects_boilerplate_and_price_labels():
    discovery = BuildingDiscovery(storage=None)

    assert discovery._is_valid_building_name("Suitable For") is False
    assert discovery._is_valid_building_name("Quote: ₹2.20 Cr") is False


def test_building_name_validation_keeps_valid_building_names():
    discovery = BuildingDiscovery(storage=None)

    for name in (
        "Godrej Emerald",
        "Lodha Park",
        "Oberoi Sky City",
        "Runwal Forests",
        "Monalisa Apartments",
    ):
        assert discovery._is_valid_building_name(name) is True
