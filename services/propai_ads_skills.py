"""Deterministic, approval-safe skills exposed to the PropAI Ads Agent."""

from __future__ import annotations

from typing import Any


ADS_SKILL_TOOLS: list[dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "propai_ads__build_audience_plan",
            "description": "Build an assumption-labeled target audience hypothesis for a realtor property. This is planning only and does not call Meta or publish anything.",
            "parameters": {
                "type": "object",
                "properties": {
                    "property_type": {"type": "string"},
                    "locality": {"type": "string"},
                    "price_or_rent": {"type": "string"},
                    "objective": {"type": "string"},
                    "audience_hints": {"type": "string"},
                },
                "required": ["property_type", "locality", "price_or_rent", "objective"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "propai_ads__build_campaign_plan",
            "description": "Turn a realtor property brief into a draft campaign structure, creative tests, measurement plan, and next decision. Planning only; no Meta mutation.",
            "parameters": {
                "type": "object",
                "properties": {
                    "brief": {"type": "string"},
                    "objective": {"type": "string"},
                    "budget_assumption": {"type": "string"},
                },
                "required": ["brief", "objective"],
            },
        },
    },
]


def is_ads_skill(name: str) -> bool:
    return name.startswith("propai_ads__")


def execute_ads_skill(name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    if name == "propai_ads__build_audience_plan":
        property_type = str(arguments.get("property_type") or "property").strip()
        locality = str(arguments.get("locality") or "the target locality").strip()
        price = str(arguments.get("price_or_rent") or "not provided").strip()
        objective = str(arguments.get("objective") or "qualified WhatsApp enquiries").strip()
        hints = str(arguments.get("audience_hints") or "No extra audience hints supplied.").strip()
        return {
            "skill": "audience_plan",
            "status": "hypothesis",
            "inputs": {"property_type": property_type, "locality": locality, "price_or_rent": price, "objective": objective, "audience_hints": hints},
            "recommendation": {
                "primary": f"People likely to be actively considering {property_type} in or around {locality}, with the budget signal '{price}'.",
                "secondary_tests": [
                    "Local-intent test: people living in or recently engaging with the locality and nearby commute corridors.",
                    "Life-stage/use-case test: align the message to the property's likely use case, only after confirming whether it is for self-use, investment, family, or business.",
                    "Retargeting test: recent video viewers, profile engagers, or landing-page visitors if a compliant audience is available.",
                ],
                "exclusions": ["Existing leads and recent converters when a reliable customer list is available.", "People outside the serviceable enquiry area."],
                "tests": ["Keep geography and offer constant; test one audience hypothesis at a time.", "Treat delivery and lead quality as unknown until live results are measured."],
            },
            "next_question": "Is this property being marketed primarily to self-use buyers, investors, tenants, or a business user?",
        }
    if name == "propai_ads__build_campaign_plan":
        brief = str(arguments.get("brief") or "").strip()[:6000]
        objective = str(arguments.get("objective") or "qualified WhatsApp enquiries").strip()
        budget = str(arguments.get("budget_assumption") or "Not provided; recommend a test range after confirming locality and lead economics.").strip()
        return {
            "skill": "campaign_plan",
            "status": "draft",
            "objective": objective,
            "brief_received": brief,
            "budget_assumption": budget,
            "structure": [
                "One campaign for the single objective.",
                "Two ad sets: local-intent audience and one confirmed use-case/audience hypothesis.",
                "Two to three creatives per ad set: property proof, lifestyle/use-case, and direct WhatsApp enquiry angle.",
            ],
            "measurement": ["Cost per qualified WhatsApp conversation", "Lead quality by audience and creative", "Response rate and appointment rate after broker follow-up"],
            "guardrails": ["Draft only; no campaign will be created or activated without approval.", "Do not claim performance before live results exist.", "Use only verified listing facts in copy."],
            "next_question": "What is the serviceable location and what qualifies as a good enquiry for this realtor?",
        }
    return {"error": f"Unknown PropAI Ads skill: {name}"}
