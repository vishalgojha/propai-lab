"""IGR Maharashtra Search - Browser-based solution.

Since IGR uses complex ASP.NET WebForms with AJAX, this module
provides a browser-based approach using Selenium/Playwright.

For automated scraping, use the headless browser approach.
For manual use, this opens the IGR website in the default browser.
"""

import webbrowser
import subprocess
import sys
from typing import Optional


def open_igr_search(
    building_name: str = "",
    district: str = "30",
    year: int = 2024,
):
    """
    Open IGR eSearch in the default browser.
    
    Args:
        building_name: Building/area name to search
        district: District code ("30" for Mumbai, "31" for Mumbai Suburban)
        year: Registration year
    """
    url = "https://freesearchigrservice.maharashtra.gov.in/"
    webbrowser.open(url)
    print(f"\nOpened IGR eSearch in your browser.")
    print(f"\nSearch for: {building_name}")
    print(f"District: {'Mumbai' if district == '30' else 'Mumbai Suburban' if district == '31' else 'Other'}")
    print(f"Year: {year}")
    print("\nSteps:")
    print("1. Click 'Mumbai / मुंबई' or 'Rest of Maharashtra'")
    print("2. Select district from dropdown")
    print("3. Enter area name (e.g., ANDHERI)")
    print("4. Select area from dropdown")
    print("5. Enter property number (optional)")
    print("6. Solve CAPTCHA and click Search")


def get_igr_bookmarklet() -> str:
    """
    Returns a JavaScript bookmarklet that can be used to automate
    IGR search from the browser console.
    
    Usage:
        1. Open IGR eSearch in browser
        2. Open browser console (F12)
        3. Paste and run the bookmarklet
    """
    return """
// IGR Auto-Fill Bookmarklet
// Paste this in browser console after opening IGR eSearch

(function() {
    // Configuration
    const CONFIG = {
        district: '30',  // 30=Mumbai, 31=Mumbai Suburban
        areaName: 'ANDHERI',
        year: '2024'
    };
    
    // Fill form fields
    const fillField = (id, value) => {
        const el = document.getElementById(id);
        if (el) {
            el.value = value;
            el.dispatchEvent(new Event('change'));
        }
    };
    
    // Click button
    const clickButton = (id) => {
        const el = document.getElementById(id);
        if (el) el.click();
    };
    
    // Fill the form
    fillField('ddlFromYear', CONFIG.year);
    fillField('ddlDistrict', CONFIG.district);
    fillField('txtAreaName', CONFIG.areaName);
    
    console.log('Form filled! Now solve CAPTCHA and click Search.');
    console.log('District:', CONFIG.district);
    console.log('Area:', CONFIG.areaName);
    console.log('Year:', CONFIG.year);
})();
"""


def create_igrexport_script():
    """
    Create a userscript for automating IGR searches.
    This can be installed as a browser extension.
    """
    script = """
// ==UserScript==
// @name         IGR Auto Search
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Automate IGR Maharashtra property search
// @author       PropAI
// @match        https://freesearchigrservice.maharashtra.gov.in/*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';
    
    // Add auto-fill button
    const btn = document.createElement('button');
    btn.innerHTML = '🔧 Auto-Fill Config';
    btn.style.cssText = 'position:fixed;top:10px;right:10px;z-index:99999;padding:10px;background:#00ff88;color:black;border:none;border-radius:5px;cursor:pointer;font-weight:bold;';
    btn.onclick = function() {
        const district = prompt('Enter district code (30=Mumbai, 31=Mumbai Suburban):', '30');
        const area = prompt('Enter area name:', 'ANDHERI');
        const year = prompt('Enter year:', '2024');
        
        if (district && area && year) {
            document.getElementById('ddlFromYear').value = year;
            document.getElementById('ddlDistrict').value = district;
            document.getElementById('txtAreaName').value = area;
            
            // Trigger postback
            __doPostBack('txtAreaName', '');
            
            alert('Form filled! Now solve CAPTCHA and search.');
        }
    };
    document.body.appendChild(btn);
})();
"""
    return script


if __name__ == "__main__":
    print("=" * 60)
    print("IGR Maharashtra Search Tool")
    print("=" * 60)
    print()
    print("Options:")
    print("1. Open IGR in browser (manual search)")
    print("2. Get bookmarklet for auto-fill")
    print("3. Get userscript for Tampermonkey")
    print()
    
    choice = input("Select option (1-3): ").strip()
    
    if choice == "1":
        building = input("Enter building/area name (or press Enter to skip): ").strip()
        district = input("Enter district code (30=Mumbai, 31=Mumbai Suburban) [30]: ").strip() or "30"
        year = input("Enter year [2024]: ").strip() or "2024"
        
        open_igr_search(building, district, int(year))
        
    elif choice == "2":
        print("\nBookmarklet (copy and paste in browser console):")
        print("-" * 60)
        print(get_igr_bookmarklet())
        
    elif choice == "3":
        print("\nTampermonkey Userscript:")
        print("-" * 60)
        print(create_igrexport_script())
        
    else:
        print("Invalid option")
