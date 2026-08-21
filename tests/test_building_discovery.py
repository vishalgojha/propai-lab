from agents.building_enrichment.crawl_discovery import extract_result_urls, score_discovery
from agents.building_enrichment.structured_extraction import extract_structured_fields


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
