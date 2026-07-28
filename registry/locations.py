"""
Mumbai location hierarchy.

Maps every known area/locality to its parent micro-market.
Based on standard Mumbai real estate market segmentation used by
99acres, MagicBricks, Housing.com, and MumbaiPropertyExchange.

IMPORTANT: Every micro_market value must be a real, specific locality
that property portals recognize. No fake aggregate buckets like
"Western Suburbs Prime" or "South Mumbai Central".
"""

# Micro markets → sub-areas they contain
# Each micro_market is a real locality name.
MICRO_MARKETS: dict[str, list[str]] = {
    "Malabar Hill": [
        "Altamount Road",
        "Breach Candy",
        "Walkeshwar",
        "Kemps Corner",
        "Peddar Road",
        "Carmichael Road",
        "Nepean Sea Road",
    ],
    "Colaba": [
        "Colaba",
        "Cuffe Parade",
    ],
    "Churchgate": [
        "Churchgate",
        "Nariman Point",
        "Marine Lines",
        "Fort",
    ],
    "Tardeo": [
        "Tardeo",
        "Gamdevi",
        "Nana Chowk",
    ],
    "Worli": [
        "Worli",
        "Worli Naka",
        "Worli Sea Face",
        "Mahalakshmi",
    ],
    "Prabhadevi": [
        "Prabhadevi",
    ],
    "Lower Parel": [
        "Lower Parel",
        "Elphinstone",
        "Kamla Mill Compound",
    ],
    "Parel": [
        "Parel",
        "Lalbaug",
    ],
    "Byculla": [
        "Byculla",
        "Byculla West",
    ],
    "Dadar West": [
        "Dadar West",
    ],
    "Dadar East": [
        "Dadar East",
    ],
    "Matunga": [
        "Matunga",
        "Matunga East",
    ],
    "Sion": [
        "Sion",
    ],
    "Wadala": [
        "Wadala",
        "Wadala East",
    ],
    "Sewri": [
        "Sewri",
    ],
    "Mumbai Central": [
        "Mumbai Central",
        "Grant Road",
        "Girgaon",
    ],
    "Bandra West": [
        "Bandra West",
        "Pali Hill",
    ],
    "Bandra East": [
        "Bandra East",
        "BKC",
        "Bandra Kurla Complex",
    ],
    "Khar West": [
        "Khar West",
    ],
    "Khar East": [
        "Khar East",
    ],
    "Santacruz West": [
        "Santacruz West",
        "Vakola",
    ],
    "Santacruz East": [
        "Santacruz East",
        "Kalina",
    ],
    "Juhu": [
        "Juhu",
        "Juhu Tara Road",
        "JVPD Scheme",
    ],
    "Vile Parle West": [
        "Vile Parle West",
    ],
    "Vile Parle East": [
        "Vile Parle East",
    ],
    "Andheri West": [
        "Andheri West",
        "Lokhandwala",
        "Versova",
        "Yari Road",
        "Oshiwara",
        "DN Nagar",
        "Seven Bungalow",
        "Seven Bungalows",
        "Azad Nagar",
    ],
    "Andheri East": [
        "Andheri East",
        "Marol",
        "Sakinaka",
        "Veera Desai",
    ],
    "Jogeshwari West": [
        "Jogeshwari West",
        "Jogeshwari",
    ],
    "Jogeshwari East": [
        "Jogeshwari East",
    ],
    "Goregaon West": [
        "Goregaon West",
    ],
    "Goregaon East": [
        "Goregaon East",
    ],
    "Malad West": [
        "Malad West",
    ],
    "Malad East": [
        "Malad East",
    ],
    "Kandivali West": [
        "Kandivali West",
        "Thakur Village",
        "Ram Mandir",
        "Charkop",
    ],
    "Kandivali East": [
        "Kandivali East",
    ],
    "Borivali West": [
        "Borivali West",
    ],
    "Borivali East": [
        "Borivali East",
    ],
    "Dahisar": [
        "Dahisar East",
        "Dahisar West",
    ],
    "Mira Road": [
        "Mira Road",
        "Mira Road East",
    ],
    "Virar": [
        "Virar",
    ],
    "Powai": [
        "Powai",
        "Chandivali",
    ],
    "Vikhroli": [
        "Vikhroli",
    ],
    "Ghatkopar": [
        "Ghatkopar West",
        "Ghatkopar East",
    ],
    "Kurla": [
        "Kurla",
    ],
    "Bhandup": [
        "Bhandup",
        "Bhandup West",
    ],
    "Mulund": [
        "Mulund West",
        "Mulund East",
        "Nahur",
    ],
    "Kanjur Marg": [
        "Kanjur Marg",
        "Kanjurmarg East",
        "Pant Nagar",
        "Samartha Nagar",
    ],
    "Chembur": [
        "Chembur",
    ],
    "Thane West": [
        "Thane West",
        "Thane East",
        "Majiwada",
        "Waghbil",
        "Kolshet",
    ],
    "Navi Mumbai": [
        "Belapur",
        "Nerul",
        "Kharghar",
        "Ghansoli",
        "Sanpada",
        "Vashi",
        "Kalamboli",
        "New Panvel",
    ],
}

# Reverse mapping: area → micro market
AREA_TO_MARKET: dict[str, str] = {}
for market, areas in MICRO_MARKETS.items():
    for area in areas:
        AREA_TO_MARKET[area.lower()] = market


# Also add direct mappings for known aliases/variants
AREA_ALIASES: dict[str, str] = {
    "—": "",
    "bkc": "BKC",
    "bkc 28": "BKC",
    "bkc annex": "BKC",
    "bkc bkc": "BKC",
    "bandra kurla complex": "BKC",
    "lokhandwala": "Lokhandwala",
    "lokhandwala complex back road": "Lokhandwala",
    "lokhandwala market": "Lokhandwala",
    "hiranandani gardens powai": "Powai",
    "hiranandani": "Hiranandani",
    "pali hill": "Pali Hill",
    "worli naka": "Worli Naka",
    "worli sea face": "Worli Sea Face",
    "nepean sea road": "Nepean Sea Road",
    "nepeansea road": "Nepean Sea Road",
    "mahalaxmi": "Mahalakshmi",
    "peddar road": "Peddar Road",
    "pedder road": "Peddar Road",
    "grant road": "Grant Road",
    "jvpd": "JVPD Scheme",
    "jvpd scheme": "JVPD Scheme",
    "elphinstone": "Elphinstone",
    "dn nagar": "DN Nagar",
    "seven bungalow": "Seven Bungalow",
    "seven bungalows": "Seven Bungalow",
    "lake homes": "Powai",
    "madhu park": "Khar West",
    "altamount road": "Altamount Road",
    "samartha": "Samartha Nagar",
    "azad nagar": "Azad Nagar",
    "yamuna nagar": "Powai",
    "ram mandir": "Ram Mandir",
    "thakur village": "Thakur Village",
    "belapur": "Belapur",
    "nerul": "Nerul",
    "kharghar": "Kharghar",
    "ghansoli": "Ghansoli",
    "sanpada": "Sanpada",
    "vashi": "Vashi",
    "kalamboli": "Kalamboli",
    "new panvel": "New Panvel",
    "mira road": "Mira Road",
    "mira road east": "Mira Road East",
    "virar": "Virar",
    "thane west": "Thane West",
    "thane east": "Thane East",
    "pant nagar": "Pant Nagar",
    "samartha nagar": "Samartha Nagar",
    "kurla": "Kurla",
    "vikhroli": "Vikhroli",
    "ghatkopar west": "Ghatkopar West",
    "ghatkopar east": "Ghatkopar East",
    "ghatkopar": "Ghatkopar West",
    "kandivali west": "Kandivali West",
    "kandivali east": "Kandivali East",
    "kandivali": "Kandivali West",
    "borivali west": "Borivali West",
    "borivali east": "Borivali East",
    "mulund west": "Mulund West",
    "mulund east": "Mulund East",
    "mulund": "Mulund West",
    "dahisar east": "Dahisar East",
    "dahisar west": "Dahisar West",
    "goregaon": "Goregaon West",
    "malad": "Malad West",
    "andheri": "Andheri West",
    "bandra": "Bandra West",
    "khar": "Khar West",
    "santacruz": "Santacruz West",
    "oshibara": "Oshiwara",
    "sewree": "Sewri",
    "sewri west": "Sewri",
    "matunga east": "Matunga East",
    "wadala": "Wadala",
    "wadala east": "Wadala East",
    "kamla mill compound": "Lower Parel",
    "kemps corner": "Kemps Corner",
    "lower parel east": "Lower Parel",
    "lower parel west": "Lower Parel",
    "byculla": "Byculla",
    "byculla west": "Byculla West",
    "dadr": "Dadar West",
    "dadar": "Dadar West",
    "dadar west": "Dadar West",
    "dadar east": "Dadar East",
    "parel": "Parel",
    "colaba": "Colaba",
    "cuffe parade": "Cuffe Parade",
    "nariman point": "Nariman Point",
    "walkeshwar": "Walkeshwar",
    "malabar hill": "Malabar Hill",
    "breach candy": "Breach Candy",
    "churchgate": "Churchgate",
    "marine drive": "Marine Drive",
    "girgaon": "Girgaon",
    "gamdevi": "Gamdevi",
    "nana chowk": "Nana Chowk",
    "lalbaug": "Lalbaug",
    "mumbai central": "Mumbai Central",
    "nepean sea road": "Nepean Sea Road",
    "tardio": "Tardeo",
    "tardo": "Tardeo",
    "mahalakshmi": "Mahalakshmi",
    "prabhadevi": "Prabhadevi",
    "worli": "Worli",
    "juhu": "Juhu",
    "versova": "Versova",
    "oshiwara": "Oshiwara",
    "yari road": "Yari Road",
    "jogeshwari west": "Jogeshwari West",
    "jogeshwari east": "Jogeshwari East",
    "jogeshwari": "Jogeshwari West",
    "marol": "Marol",
    "sakinaka": "Sakinaka",
    "veera desai": "Veera Desai",
    "powai": "Powai",
    "chandivali": "Chandivali",
    "kanjur marg": "Kanjur Marg",
    "kanjurmarg east": "Kanjurmarg East",
    "bhandup west": "Bhandup West",
    "bhandup": "Bhandup West",
    "chembur": "Chembur",
}


def get_micro_market(area: str) -> str:
    """Get the micro market for a given area name."""
    key = area.strip().lower()

    # First try area alias resolution
    if key in AREA_ALIASES:
        resolved = AREA_ALIASES[key]
        if not resolved:
            return ""
        key = resolved.lower()

    # Then look up in the reverse mapping
    if key in AREA_TO_MARKET:
        return AREA_TO_MARKET[key]

    return ""


def get_canonical_area(area: str) -> str:
    """Resolve an area to its canonical name."""
    key = area.strip().lower()
    if key in AREA_ALIASES:
        return AREA_ALIASES[key]
    return area.strip()
