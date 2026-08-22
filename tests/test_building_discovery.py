from agents.building_enrichment.crawl_discovery import extract_result_urls, rendered_page_text, score_discovery
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


def test_trinity_is_not_rejected_as_a_name_label():
    from extraction_quality import building_name_problem

    assert building_name_problem("Name- Trinity", locality="Khar West") is None
