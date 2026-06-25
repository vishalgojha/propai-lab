"""
Known Mumbai real estate developers.
Maps developer names and their known name prefixes/suffixes.
"""
import re

# Known developers with canonical name and matching patterns
DEVELOPERS = [
    # Tier 1: Major developers
    {"name": "Lodha Group", "patterns": ["lodha"]},
    {"name": "Runwal Group", "patterns": ["runwal"]},
    {"name": "Kalpataru Group", "patterns": ["kalpataru"]},
    {"name": "Piramal Realty", "patterns": ["piramal"]},
    {"name": "Godrej Properties", "patterns": ["godrej"]},
    {"name": "Oberoi Realty", "patterns": ["oberoi"]},
    {"name": "K. Raheja Group", "patterns": ["raheja"]},
    {"name": "Hiranandani Group", "patterns": ["hiranandani"]},
    {"name": "Kanakia Group", "patterns": ["kanakia"]},
    {"name": "Wadhwa Group", "patterns": ["wadhwa"]},
    {"name": "Rustomjee Group", "patterns": ["rustomjee"]},
    {"name": "Omkar Realtors", "patterns": ["omkar"]},
    {"name": "Prestige Group", "patterns": ["prestige"]},
    {"name": "Rohan Lifescapes", "patterns": ["rohan lifescapes", "rohan "]},
    {"name": "Dosti Realty", "patterns": ["dosti "]},
    {"name": "L&T Realty", "patterns": ["l&t ", "larsen"]},
    {"name": "Indiabulls Real Estate", "patterns": ["indiabulls", "india bulls"]},
    {"name": "Brigade Group", "patterns": ["brigade"]},
    {"name": "Sobha Limited", "patterns": ["sobha"]},
    # Tier 2: Mid-sized developers
    {"name": "HDIL", "patterns": ["hdil"]},
    {"name": "Hubtown", "patterns": ["hubtown"]},
    {"name": "Marathon Group", "patterns": ["marathon"]},
    {"name": "Neptune Group", "patterns": ["neptune"]},
    {"name": "Transcon Developers", "patterns": ["transcon"]},
    {"name": "Ekta World", "patterns": ["ekta"]},
    {"name": "Dheeraj Group", "patterns": ["dheeraj"]},
    {"name": "Mantri Developers", "patterns": ["mantri"]},
    {"name": "Ruparel Group", "patterns": ["ruparel"]},
    {"name": "Sugee Group", "patterns": ["sugee"]},
    {"name": "Gundecha Group", "patterns": ["gundecha"]},
    {"name": "Remi Group", "patterns": ["remi "]},
    {"name": "DLH Group", "patterns": ["dlh "]},
    {"name": "Naman Group", "patterns": ["naman "]},
    {"name": "Adani Realty", "patterns": ["adani "]},
    {"name": "Sunteck Realty", "patterns": ["sunteck"]},
    {"name": "Ashiana Group", "patterns": ["ashiana"]},
    {"name": "Arihant Group", "patterns": ["arihant"]},
    {"name": "Rivali Park", "patterns": ["rivali"]},
    {"name": "Jagat Group", "patterns": ["jagat"]},
    {"name": "Conwood Group", "patterns": ["conwood"]},
    {"name": "Kohinoor Group", "patterns": ["kohinoor"]},
    {"name": "Shapoorji Pallonji", "patterns": ["shapoorji"]},
    {"name": "Mahindra Lifespaces", "patterns": ["mahindra"]},
    {"name": "Tata Housing", "patterns": ["tata "]},
    {"name": "Poddar Housing", "patterns": ["poddar"]},
    {"name": "Peninsula Group", "patterns": ["peninsula"]},
    {"name": "DB Realty", "patterns": ["db realty"]},
    {"name": "Nirmal Lifestyle", "patterns": ["nirmal "]},
    {"name": "Ajmera Group", "patterns": ["ajmera"]},
    {"name": "Sheth Developers", "patterns": ["sheth "]},
    {"name": "Vascon Engineers", "patterns": ["vascon"]},
    {"name": "Bombay Dyeing", "patterns": ["bombay dyeing"]},
    {"name": "Mumbai Builders", "patterns": []},  # fallback
]


def extract_developer(building_name: str) -> str | None:
    """Try to identify the developer from a building name."""
    name_lower = building_name.lower().strip()
    
    # Remove common suffixes that might interfere
    cleaned = name_lower.replace("'s", "").replace("s'", "")
    
    best_match = None
    best_len = 0
    
    for dev in DEVELOPERS:
        for pat in dev["patterns"]:
            if pat in cleaned:
                # Prefer longer, more specific patterns
                if len(pat) > best_len:
                    best_match = dev["name"]
                    best_len = len(pat)
    
    return best_match
