"""IGR Maharashtra eSearch Scraper.

Searches property registrations on IGR Maharashtra portal.
Uses ddddocr for automatic CAPTCHA solving.

Two search modes:
1. Property Details (मिळकत निहाय): Requires exact CTS/Survey/Milkat number
2. Document Number (दस्त निहाय): Requires exact document number + registration type

Note: IGR does NOT support searching by building name.
You must know the exact property number (CTS/Survey) or document number.

Usage:
    from agents.igr_scraper import IGRScraper

    scraper = IGRScraper()

    # Get available districts
    districts = scraper.get_districts(rest_of_maharashtra=True)

    # Get tahsils for a district
    tahsils = scraper.get_tahsils(district_code="6")

    # Get villages for a tahsil
    villages = scraper.get_villages(tahsil_code="9 ")

    # Search by property (requires exact CTS number)
    results = scraper.search_property_details(
        district_code="6",
        tahsil_code="9 ",
        village="ठाणे",
        property_no="1234",
        year=2025,
    )
"""

import re
import time
import logging
import requests
from typing import Optional
from dataclasses import dataclass, field
from urllib.parse import urljoin

logger = logging.getLogger(__name__)

BASE_URL = "https://freesearchigrservice.maharashtra.gov.in/"

try:
    import ddddocr
    OCR = ddddocr.DdddOcr(show_ad=False)
    HAS_OCR = True
except ImportError:
    HAS_OCR = False
    logger.warning("ddddocr not installed, CAPTCHA solving disabled")


@dataclass
class IGRResult:
    """Single IGR search result."""
    index_no: str = ""
    document_type: str = ""
    registration_date: str = ""
    deed_date: str = ""
    property_description: str = ""
    flat_no: str = ""
    building_name: str = ""
    area: str = ""
    consideration_amount: str = ""
    stamp_duty_paid: str = ""
    seller_name: str = ""
    buyer_name: str = ""
    survey_no: str = ""
    sro: str = ""
    district: str = ""
    raw_data: dict = field(default_factory=dict)


class IGRScraper:
    """Scrapes IGR Maharashtra eSearch portal."""

    def __init__(self):
        self.session = requests.Session()
        self.session.headers.update({
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.5",
        })

    def _extract_form_fields(self, html: str) -> dict:
        """Extract all form fields from HTML."""
        fields = {}
        for m in re.finditer(r'<input[^>]*>', html, re.IGNORECASE):
            tag = m.group(0)
            name = re.search(r'name="([^"]*)"', tag)
            value = re.search(r'value="([^"]*)"', tag)
            itype = re.search(r'type="([^"]*)"', tag)
            if name:
                if itype and itype.group(1).lower() == 'hidden':
                    fields[name.group(1)] = value.group(1) if value else ''
                elif itype and itype.group(1).lower() == 'text':
                    fields[name.group(1)] = ''
        for m in re.finditer(r'<select[^>]*name="([^"]*)"[^>]*>(.*?)</select>', html, re.DOTALL | re.IGNORECASE):
            select_name = m.group(1)
            options_html = m.group(2)
            selected = re.search(r'<option[^>]*selected="selected"[^>]*value="([^"]*)"', options_html)
            if selected:
                fields[select_name] = selected.group(1)
            else:
                first = re.search(r'<option[^>]*value="([^"]*)"', options_html)
                if first:
                    fields[select_name] = first.group(1)
        return fields

    def _get_options(self, html: str, select_name: str) -> list[tuple[str, str]]:
        """Extract options from a select element."""
        match = re.search(rf'<select[^>]*name="{select_name}"[^>]*>(.*?)</select>', html, re.DOTALL)
        if not match:
            return []
        return re.findall(r'<option[^>]*value="([^"]*)"[^>]*>([^<]+)', match.group(1))

    def _solve_captcha(self, html: str) -> tuple[str, str]:
        """Download and solve CAPTCHA. Returns (captcha_text, handler_hash)."""
        handler_refs = re.findall(r'Handler\.ashx\?txt=([^"\'<>\s]*)', html)
        if not handler_refs:
            return "", ""
        captcha_url = urljoin(BASE_URL, f'Handler.ashx?txt={handler_refs[0]}')
        resp = self.session.get(captcha_url, timeout=10)
        if HAS_OCR:
            text = OCR.classification(resp.content)
            text = re.sub(r'[^a-zA-Z0-9]', '', text)
            return text, handler_refs[0]
        return "", handler_refs[0]

    def _post(self, data: dict) -> requests.Response:
        """POST to IGR."""
        return self.session.post(BASE_URL, data=data, timeout=60)

    def get_districts(self, rest_of_maharashtra: bool = True) -> list[dict]:
        """Get available districts."""
        resp = self.session.get(BASE_URL, timeout=30)
        fields = self._extract_form_fields(resp.text)

        if rest_of_maharashtra:
            data = dict(fields)
            data['__EVENTTARGET'] = 'btnOtherdistrictSearch'
            data['__EVENTARGUMENT'] = ''
            data['__LASTFOCUS'] = ''
            data['btnOtherdistrictSearch'] = 'Rest of Maharashtra / उर्वरित महाराष्ट्र'
            resp = self._post(data)
            options = self._get_options(resp.text, 'ddlDistrict1')
        else:
            data = dict(fields)
            data['__EVENTTARGET'] = 'btnMumbaisearch'
            data['__EVENTARGUMENT'] = ''
            data['__LASTFOCUS'] = ''
            data['btnMumbaisearch'] = 'Mumbai / मुंबई'
            resp = self._post(data)
            options = self._get_options(resp.text, 'ddlDistrict')

        return [{"code": v, "name": t.strip()} for v, t in options if v and 'Select' not in t]

    def get_tahsils(self, district_code: str) -> list[dict]:
        """Get tahsils for a district (Rest of Maharashtra only)."""
        resp = self.session.get(BASE_URL, timeout=30)
        fields = self._extract_form_fields(resp.text)

        data = dict(fields)
        data['__EVENTTARGET'] = 'btnOtherdistrictSearch'
        data['__EVENTARGUMENT'] = ''
        data['__LASTFOCUS'] = ''
        data['btnOtherdistrictSearch'] = 'Rest of Maharashtra / उर्वरित महाराष्ट्र'
        resp = self._post(data)
        fields = self._extract_form_fields(resp.text)

        data = dict(fields)
        data['__EVENTTARGET'] = 'ddlDistrict1'
        data['__EVENTARGUMENT'] = ''
        data['__LASTFOCUS'] = ''
        data['ddlDistrict1'] = district_code
        resp = self._post(data)

        options = self._get_options(resp.text, 'ddltahsil')
        return [{"code": v, "name": t.strip()} for v, t in options if v and 'Select' not in t]

    def get_villages(self, district_code: str, tahsil_code: str) -> list[dict]:
        """Get villages for a tahsil (Rest of Maharashtra only)."""
        resp = self.session.get(BASE_URL, timeout=30)
        fields = self._extract_form_fields(resp.text)

        data = dict(fields)
        data['__EVENTTARGET'] = 'btnOtherdistrictSearch'
        data['__EVENTARGUMENT'] = ''
        data['__LASTFOCUS'] = ''
        data['btnOtherdistrictSearch'] = 'Rest of Maharashtra / उर्वरित महाराष्ट्र'
        resp = self._post(data)
        fields = self._extract_form_fields(resp.text)

        data = dict(fields)
        data['__EVENTTARGET'] = 'ddlDistrict1'
        data['__EVENTARGUMENT'] = ''
        data['__LASTFOCUS'] = ''
        data['ddlDistrict1'] = district_code
        resp = self._post(data)
        fields = self._extract_form_fields(resp.text)

        data = dict(fields)
        data['__EVENTTARGET'] = 'ddltahsil'
        data['__EVENTARGUMENT'] = ''
        data['__LASTFOCUS'] = ''
        data['ddltahsil'] = tahsil_code
        resp = self._post(data)

        options = self._get_options(resp.text, 'ddlvillage')
        return [{"code": v, "name": t.strip()} for v, t in options if v and 'Select' not in t]

    def get_sros(self, district_code: str) -> list[dict]:
        """Get Sub-Registrar Offices for a district (Document Number search)."""
        resp = self.session.get(BASE_URL, timeout=30)
        fields = self._extract_form_fields(resp.text)

        data = dict(fields)
        data['__EVENTTARGET'] = 'btnMumbaisearch'
        data['__EVENTARGUMENT'] = ''
        data['__LASTFOCUS'] = ''
        data['btnMumbaisearch'] = 'Mumbai / मुंबई'
        resp = self._post(data)
        fields = self._extract_form_fields(resp.text)

        # Switch to Document Number tab
        data = dict(fields)
        data['__EVENTTARGET'] = ''
        data['__EVENTARGUMENT'] = ''
        data['__LASTFOCUS'] = ''
        data['rblDocType'] = '0'
        resp = self._post(data)

        options = self._get_options(resp.text, 'ddlSROName')
        return [{"code": v, "name": t.strip()} for v, t in options if v and 'Select' not in t]

    def search_property_details(
        self,
        district_code: str,
        tahsil_code: str,
        village: str,
        property_no: str,
        year: int = 2025,
    ) -> list[IGRResult]:
        """
        Search by property details (Rest of Maharashtra).

        Requires exact CTS/Survey/Milkat number.
        """
        resp = self.session.get(BASE_URL, timeout=30)
        fields = self._extract_form_fields(resp.text)

        # Click Rest of Maharashtra
        data = dict(fields)
        data['__EVENTTARGET'] = 'btnOtherdistrictSearch'
        data['__EVENTARGUMENT'] = ''
        data['__LASTFOCUS'] = ''
        data['btnOtherdistrictSearch'] = 'Rest of Maharashtra / उर्वरित महाराष्ट्र'
        resp = self._post(data)
        fields = self._extract_form_fields(resp.text)

        # Select district
        data = dict(fields)
        data['__EVENTTARGET'] = 'ddlDistrict1'
        data['__EVENTARGUMENT'] = ''
        data['__LASTFOCUS'] = ''
        data['ddlDistrict1'] = district_code
        resp = self._post(data)
        fields = self._extract_form_fields(resp.text)

        # Select tahsil
        data = dict(fields)
        data['__EVENTTARGET'] = 'ddltahsil'
        data['__EVENTARGUMENT'] = ''
        data['__LASTFOCUS'] = ''
        data['ddltahsil'] = tahsil_code
        resp = self._post(data)
        fields = self._extract_form_fields(resp.text)

        # Select village
        data = dict(fields)
        data['__EVENTTARGET'] = 'ddlvillage'
        data['__EVENTARGUMENT'] = ''
        data['__LASTFOCUS'] = ''
        data['ddlvillage'] = village
        resp = self._post(data)
        fields = self._extract_form_fields(resp.text)

        # Solve CAPTCHA
        captcha_text, _ = self._solve_captcha(resp.text)
        if not captcha_text:
            logger.error("Failed to solve CAPTCHA")
            return []

        # Search
        data = dict(fields)
        data['__EVENTTARGET'] = ''
        data['__EVENTARGUMENT'] = ''
        data['__LASTFOCUS'] = ''
        data['ddlFromYear1'] = str(year)
        data['ddlvillage'] = village
        data['txtAttributeValue1'] = property_no
        data['txtImg1'] = captcha_text
        data['btnSearch_RestMaha'] = 'शोध / Search'
        resp = self._post(data)

        return self._parse_results(resp.text)

    def search_mumbai_property(
        self,
        district_code: str,
        area_name: str,
        property_no: str,
        year: int = 2025,
    ) -> list[IGRResult]:
        """
        Search Mumbai property.

        Note: Area dropdown autocomplete does not work via automated requests.
        The area name is typed in txtAreaName but the dropdown is not populated.
        Search may return no results without area selection.
        """
        resp = self.session.get(BASE_URL, timeout=30)
        fields = self._extract_form_fields(resp.text)

        # Click Mumbai
        data = dict(fields)
        data['__EVENTTARGET'] = 'btnMumbaisearch'
        data['__EVENTARGUMENT'] = ''
        data['__LASTFOCUS'] = ''
        data['btnMumbaisearch'] = 'Mumbai / मुंबई'
        resp = self._post(data)
        fields = self._extract_form_fields(resp.text)

        # Select district
        data = dict(fields)
        data['__EVENTTARGET'] = 'ddlDistrict'
        data['__EVENTARGUMENT'] = ''
        data['__LASTFOCUS'] = ''
        data['ddlDistrict'] = district_code
        resp = self._post(data)
        fields = self._extract_form_fields(resp.text)

        # Type area name (triggers postback but area dropdown won't populate)
        data = dict(fields)
        data['__EVENTTARGET'] = 'txtAreaName'
        data['__EVENTARGUMENT'] = ''
        data['__LASTFOCUS'] = ''
        data['txtAreaName'] = area_name
        resp = self._post(data)
        fields = self._extract_form_fields(resp.text)

        # Solve CAPTCHA
        captcha_text, _ = self._solve_captcha(resp.text)
        if not captcha_text:
            logger.error("Failed to solve CAPTCHA")
            return []

        # Search
        data = dict(fields)
        data['__EVENTTARGET'] = ''
        data['__EVENTARGUMENT'] = ''
        data['__LASTFOCUS'] = ''
        data['ddlFromYear'] = str(year)
        data['txtAreaName'] = area_name
        data['ddlareaname'] = '-----Select Area----'
        data['txtAttributeValue'] = property_no
        data['txtImg'] = captcha_text
        data['btnSearch'] = 'शोध / Search'
        resp = self._post(data)

        return self._parse_results(resp.text)

    def search_document_number(
        self,
        district_code: str,
        sro_code: str,
        doc_type: int,
        doc_number: str,
        year: int = 2025,
    ) -> list[IGRResult]:
        """
        Search by document number.

        Args:
            district_code: District code
            sro_code: Sub-Registrar Office code
            doc_type: Document type (0=Agreement, 1=Conveyance, etc.)
            doc_number: Document number
            year: Registration year
        """
        resp = self.session.get(BASE_URL, timeout=30)
        fields = self._extract_form_fields(resp.text)

        # Click Mumbai
        data = dict(fields)
        data['__EVENTTARGET'] = 'btnMumbaisearch'
        data['__EVENTARGUMENT'] = ''
        data['__LASTFOCUS'] = ''
        data['btnMumbaisearch'] = 'Mumbai / मुंबई'
        resp = self._post(data)
        fields = self._extract_form_fields(resp.text)

        # Switch to Document Number tab by posting with doc fields
        data = dict(fields)
        data['__EVENTTARGET'] = ''
        data['__EVENTARGUMENT'] = ''
        data['__LASTFOCUS'] = ''
        data['rblDocType'] = str(doc_type)
        data['txtDocumentNo'] = doc_number
        data['ddldistrictfordoc'] = district_code
        data['ddlSROName'] = sro_code
        data['ddlYearForDoc'] = str(year)
        resp = self._post(data)
        fields = self._extract_form_fields(resp.text)

        # Solve CAPTCHA
        captcha_text, _ = self._solve_captcha(resp.text)
        if not captcha_text:
            logger.error("Failed to solve CAPTCHA")
            return []

        # Search
        data = dict(fields)
        data['__EVENTTARGET'] = ''
        data['__EVENTARGUMENT'] = ''
        data['__LASTFOCUS'] = ''
        data['rblDocType'] = str(doc_type)
        data['txtDocumentNo'] = doc_number
        data['ddldistrictfordoc'] = district_code
        data['ddlSROName'] = sro_code
        data['ddlYearForDoc'] = str(year)
        data['TextBox1'] = captcha_text
        data['btnSearchDoc'] = 'शोध / Search'
        resp = self._post(data)

        return self._parse_results(resp.text)

    def _parse_results(self, html: str) -> list[IGRResult]:
        """Parse search results from HTML."""
        results = []

        table_match = re.search(
            r'<table[^>]*id="gvDetails"[^>]*>(.*?)</table>',
            html, re.DOTALL | re.IGNORECASE
        )
        if not table_match:
            return []

        rows = re.findall(r'<tr[^>]*>(.*?)</tr>', table_match.group(1), re.DOTALL)
        for row in rows[1:]:
            cells = re.findall(r'<td[^>]*>(.*?)</td>', row, re.DOTALL)
            if len(cells) >= 8:
                result = IGRResult()
                result.index_no = self._clean_cell(cells[0])
                result.document_type = self._clean_cell(cells[1])
                result.registration_date = self._clean_cell(cells[2])
                result.deed_date = self._clean_cell(cells[3])
                result.property_description = self._clean_cell(cells[4])
                result.consideration_amount = self._clean_cell(cells[5])
                result.stamp_duty_paid = self._clean_cell(cells[6])
                result.sro = self._clean_cell(cells[7])
                self._extract_building_info(result)
                results.append(result)

        return results

    def _clean_cell(self, cell_html: str) -> str:
        text = re.sub(r'<[^>]+>', '', cell_html)
        text = text.replace('&amp;', '&').replace('&lt;', '<').replace('&gt;', '>')
        text = text.replace('&#39;', "'").replace('&quot;', '"')
        return text.strip()

    def _extract_building_info(self, result: IGRResult):
        desc = result.property_description
        if not desc:
            return
        parts = [p.strip() for p in desc.split(",")]
        if len(parts) >= 2:
            result.building_name = parts[1]
            if len(parts) >= 3:
                result.area = parts[-1]
        elif len(parts) == 1:
            match = re.match(r'(?:Flat|Unit|Property)\s+\d+[,\s]+(.+?)(?:,\s*(.+))?$', desc)
            if match:
                result.building_name = match.group(1)
                if match.group(2):
                    result.area = match.group(2)


def search_igr(
    building_name: str,
    district: str = "30",
    year: int = 2024,
) -> list[dict]:
    """Convenience function - limited by IGR's search capabilities."""
    logger.warning(
        "IGR does not support searching by building name. "
        "Use search_property_details() with exact CTS/Survey numbers."
    )
    return []


if __name__ == "__main__":
    import sys

    scraper = IGRScraper()

    if len(sys.argv) < 2:
        print("Usage: python igr_scraper.py <command> [args]")
        print("Commands:")
        print("  districts              - List available districts")
        print("  tahsils <district>     - List tahsils for a district")
        print("  villages <dist> <tah>  - List villages for a tahsil")
        print("  search <dist> <tah> <village> <prop_no> [year]")
        sys.exit(1)

    cmd = sys.argv[1]

    if cmd == "districts":
        districts = scraper.get_districts()
        for d in districts:
            print(f"  {d['code']}: {d['name']}")

    elif cmd == "tahsils":
        district = sys.argv[2]
        tahsils = scraper.get_tahsils(district)
        for t in tahsils:
            print(f"  {t['code']}: {t['name']}")

    elif cmd == "villages":
        district = sys.argv[2]
        tahsil = sys.argv[3]
        villages = scraper.get_villages(district, tahsil)
        for v in villages:
            print(f"  {v['code']}: {v['name']}")

    elif cmd == "search":
        district = sys.argv[2]
        tahsil = sys.argv[3]
        village = sys.argv[4]
        prop_no = sys.argv[5]
        year = int(sys.argv[6]) if len(sys.argv) > 6 else 2025

        results = scraper.search_property_details(
            district, tahsil, village, prop_no, year
        )
        print(f"\nFound {len(results)} results:")
        for r in results:
            print(f"  {r.index_no} | {r.registration_date} | {r.consideration_amount} | {r.property_description[:50]}")

    else:
        print(f"Unknown command: {cmd}")
