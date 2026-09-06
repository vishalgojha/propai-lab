"""Runtime domain context shared with AI extraction.

``docs/GLOSSARY.md`` remains the human-readable source of truth. This compact
version is the prompt-safe subset that prevents an AI provider from applying
US/UK real-estate meanings to Indian broker language.
"""

INDIAN_REAL_ESTATE_GLOSSARY = """PROPai INDIAN REAL-ESTATE DOMAIN CONTEXT — use this when wording is ambiguous:
- Money is INR. 1 lakh/lac/lacs/L = 100,000; 1 crore/cr = 10,000,000. Preserve the raw wording.
- BHK and RK are Indian configurations: “1 RK” is not “1 BHK”.
- Transaction types are SALE (property being sold), RENT (property being rented out), LEASE (usually commercial longer-term lease), and PRE_LEASED (property sold with an existing tenant/lease).
- “outright”, “outrate”, “sell”, “buy”, and “purchase” indicate SALE. “pre-leased”, “preleased”, and “pre-rented” indicate SALE with an existing tenant; any stated rent is tenant yield, not the sale asking price.
- “rent”, “rental”, “monthly rent”, “per month”, “leave & license”, and “L&L” indicate RENT. “on lease” is rental wording in residential broker messages, but commercial lease must remain LEASE when the source says so.
- “requirement”, “wanted”, “looking for”, “looking to buy/rent”, “client needs”, and “budget” describe DEMAND, not an available listing.
- Locality means an Indian micro-market such as Bandra West, Khar, or Andheri East; a society/project name is a building. Never promote a locality to a building.
- “carpet”, “cpt”, “built-up”, “bup”, “society”, “wing”, and “jodi” have their Indian broker meanings. “jodi” is one combined opportunity, not two flats.
- “fully furnished”, “semi-furnished”, “S/F”, “builder finish”, “bare shell”, and “warm shell” are furnishing/fit-out facts, never transaction types.
- Never import US/UK assumptions, invent missing facts, or use this context to override an explicit source quote. If the source is genuinely ambiguous, preserve the raw wording and flag it."""


def build_ai_domain_context() -> str:
    """Return the stable, prompt-safe glossary context for AI providers."""
    return INDIAN_REAL_ESTATE_GLOSSARY
