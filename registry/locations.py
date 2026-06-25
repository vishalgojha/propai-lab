"""
Mumbai location hierarchy.

Maps every known area/locality to its micro market.
Based on standard Mumbai real estate market segmentation.
"""

# Micro markets → areas they contain
MICRO_MARKETS: dict[str, list[str]] = {
    "South Mumbai Prime": [
        "Altamount Road",
        "Breach Candy",
        "Cuffe Parade",
        "Colaba",
        "Churchgate",
        "Marine Drive",
        "Nariman Point",
        "Walkeshwar",
        "Malabar Hill",
        "Kemps Corner",
        "Peddar Road",
        "Tardeo",
        "Nepean Sea Road",
        "Carmichael Road",
        "Gamdevi",
        "Nana Chowk",
    ],
    "South Mumbai Central": [
        "Mahalakshmi",
        "Prabhadevi",
        "Worli",
        "Worli Naka",
        "Worli Sea Face",
        "Lower Parel",
        "Parel",
        "Elphinstone",
        "Byculla",
        "Byculla West",
        "Lalbaug",
        "Mumbai Central",
        "Grant Road",
        "Girgaon",
        "Dadar West",
        "Dadar East",
    ],
    "Western Suburbs Prime": [
        "Bandra West",
        "Bandra East",
        "BKC",
        "Khar West",
        "Khar East",
        "Santacruz West",
        "Santacruz East",
        "Pali Hill",
        "Juhu",
        "Juhu Tara Road",
        "JVPD Scheme",
        "Vile Parle West",
        "Vile Parle East",
    ],
    "Western Suburbs Mid": [
        "Andheri West",
        "Andheri East",
        "Lokhandwala",
        "Versova",
        "Yari Road",
        "Oshiwara",
        "DN Nagar",
        "Seven Bungalow",
        "Azad Nagar",
        "Jogeshwari",
        "Jogeshwari West",
        "Jogeshwari East",
        "Marol",
        "Sakinaka",
        "Veera Desai",
    ],
    "Western Suburbs Extended": [
        "Goregaon West",
        "Goregaon East",
        "Malad West",
        "Malad East",
        "Kandivali West",
        "Kandivali East",
        "Borivali West",
        "Borivali East",
        "Dahisar East",
        "Ram Mandir",
        "Thakur Village",
    ],
    "Western Suburbs Far": [
        "Mira Road",
        "Mira Road East",
        "Virar",
    ],
    "Eastern Suburbs": [
        "Kurla",
        "Vikhroli",
        "Ghatkopar West",
        "Ghatkopar East",
        "Powai",
        "Chandivali",
        "Kanjur Marg",
        "Kanjurmarg East",
        "Bhandup",
        "Bhandup West",
        "Mulund West",
        "Mulund East",
        "Nahur",
        "LBS Marg",
        "Pant Nagar",
        "Samartha Nagar",
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
    "Thane": [
        "Thane West",
        "Thane East",
        "Majiwada",
        "Waghbil",
        "Kolshet",
    ],
    "Central Suburbs": [
        "Matunga",
        "Matunga East",
        "Sewri",
        "Wadala",
        "Wadala East",
        "Sion",
    ],
    "Mumbai Trans Harbour": [
        "Uran",
        "Nhava",
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
    "hiranandani": "Hiranandani",  # Powai specific
    "pali hill": "Pali Hill",
    "worli naka": "Worli Naka",
    "worli sea face": "Worli Sea Face",
    "nepean sea road": "Nepean Sea Road",
    "nepeansea road": "Nepean Sea Road",
    "mahalaxmi": "Mahalakshmi",
    "peddar road": "Peddar Road",
    "pedder road": "Peddar Road",
    "grant road": "Grant Road",
    "navi mumbai": "Kharghar",  # too broad, map to a default
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
    # Building-specific or too vague — keep as-is
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
    "kandivali": "Kandivali West",  # default
    "borivali west": "Borivali West",
    "borivali east": "Borivali East",
    "mulund west": "Mulund West",
    "mulund east": "Mulund East",
    "mulund": "Mulund West",  # default
    "dahisar east": "Dahisar East",
    "goregaon": "Goregaon West",  # default bare
    "malad": "Malad West",  # default bare
    "andheri": "Andheri West",  # default bare
    "bandra": "Bandra West",  # default bare
    "khar": "Khar West",  # default bare
    "santacruz": "Santacruz West",  # default bare
    "oshibara": "Oshiwara",
    "sewree": "Sewri",
    "sewri west": "Sewri",
    "matunga east": "Matunga East",
    "wadala": "Wadala",
    "wadala east": "Wadala East",
    "kamla mill compound": "Lower Parel",
    "kemps corner": "Kemps Corner",
    "tardeo": "Tardeo",
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
    "grant road": "Grant Road",
    "mumbai central": "Mumbai Central",
    "altamount road": "Altamount Road",
    "nepean sea road": "Nepean Sea Road",
    "peddar road": "Peddar Road",
    "tardeo": "Tardeo",
    "mahalakshmi": "Mahalakshmi",
    "prabhadevi": "Prabhadevi",
    "worli": "Worli",
    "lower parel": "Lower Parel",
    "parel": "Parel",
    "elphinstone": "Elphinstone",
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
