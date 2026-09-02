/* Design direction: Mumbai Editorial Utility — now expressed as a city-agnostic marketplace system with warm paper surfaces, ink contrast, signal green for live states, editorial asymmetry, and direct WhatsApp handoff. */

import { useMemo, useState } from "react";
import { Link } from "wouter";
import {
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronRight,
  Clock3,
  Menu,
  MessagesSquare,
  Search,
  Send,
  ShieldCheck,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

const signalMark = "/manus-storage/propai-signal-mark_74a178d6.png";
const heroArchitecture = "/manus-storage/propai-hero-architecture_d3496149.jpg";
const localityTexture = "/manus-storage/propai-locality-texture_b9ff761a.jpg";

// Mock database response shape: in production, this entire object is returned by the API.
// The page renders from these records rather than embedding a city into the layout.
const marketData = {
  Mumbai: {
    name: "Mumbai",
    liveToday: "86",
    localitiesCovered: "24",
    localityExample: "Bandra West",
    listingCount: "1,842",
    localities: [
      { name: "Bandra West", count: "238 live listings", detail: "Sea-facing, family homes, 1–4 BHK" },
      { name: "Khar West", count: "174 live listings", detail: "Quiet lanes, older buildings, Jodi options" },
      { name: "Santacruz West", count: "149 live listings", detail: "Connected, residential, OC-ready" },
      { name: "Andheri West", count: "312 live listings", detail: "Transit-friendly, broad inventory" },
      { name: "Powai", count: "126 live listings", detail: "Townships, open views, newer stock" },
      { name: "BKC", count: "83 live listings", detail: "Workday convenience, premium rentals" },
    ],
  },
  Bengaluru: {
    name: "Bengaluru",
    liveToday: "64",
    localitiesCovered: "18",
    localityExample: "Indiranagar",
    listingCount: "1,204",
    localities: [
      { name: "Indiranagar", count: "188 live listings", detail: "Walkable streets, homes, and offices" },
      { name: "Koramangala", count: "162 live listings", detail: "Start-up belt, rentals, and retail" },
      { name: "Whitefield", count: "214 live listings", detail: "Newer homes near the tech corridor" },
      { name: "HSR Layout", count: "136 live listings", detail: "Family homes, cafes, and calm streets" },
      { name: "Jayanagar", count: "92 live listings", detail: "Established neighbourhood, larger homes" },
      { name: "Hebbal", count: "78 live listings", detail: "Connected, open, and growing" },
    ],
  },
  Pune: {
    name: "Pune",
    liveToday: "51",
    localitiesCovered: "16",
    localityExample: "Koregaon Park",
    listingCount: "938",
    localities: [
      { name: "Koregaon Park", count: "108 live listings", detail: "Leafy streets, rentals, and restaurants" },
      { name: "Kalyani Nagar", count: "96 live listings", detail: "Modern homes and flexible workspaces" },
      { name: "Baner", count: "142 live listings", detail: "Newer stock, views, and daily convenience" },
      { name: "Viman Nagar", count: "117 live listings", detail: "Connected, furnished, and practical" },
      { name: "Kothrud", count: "124 live listings", detail: "Residential depth, family-sized homes" },
      { name: "Hinjewadi", count: "88 live listings", detail: "Tech corridor, rentals, and value" },
    ],
  },
} as const;

type City = keyof typeof marketData;
type AssetClass = "All" | "Residential" | "Commercial";
type Transaction = "Rent" | "Sale";

type ListingRecord = {
  city: City;
  assetClass: Exclude<AssetClass, "All">;
  transaction: Transaction;
  title: string;
  locality: string;
  price: string;
  facts: string;
  freshness: string;
  href: string;
};

// Records are intentionally shaped like live inventory rows so the visual layout stays reusable.
const listingRecords: ListingRecord[] = [
  { city: "Mumbai", assetClass: "Residential", transaction: "Sale", title: "3 BHK for sale", locality: "Mumbai", price: "Price on request", facts: "3 BHK · Carpet area on enquiry", freshness: "Updated 21h ago", href: "/listings/3-bhk-for-sale-30627/30627" },
  { city: "Mumbai", assetClass: "Residential", transaction: "Sale", title: "3 BHK with servants quarter in Parel", locality: "Peninsula Celestia Spaces, Parel", price: "₹6.50 Cr", facts: "3 BHK · 1,468 sqft · OC", freshness: "Updated 21h ago", href: "/listings/3-bhk-for-sale-peninsula-celestia-spaces-30626/30626" },
  { city: "Mumbai", assetClass: "Residential", transaction: "Rent", title: "Fully furnished 1 BHK near Lilavati Hospital", locality: "Reclamation, Bandra West", price: "₹80,000 / month", facts: "1 BHK · Fully furnished · Jodi possible", freshness: "Updated 21h ago", href: "/listings/1-bhk-for-rent-kamal-pushpa-near-lilavati-hospital-reclamation-bandra-west-fully-furnished-9501/9501" },
  { city: "Mumbai", assetClass: "Residential", transaction: "Rent", title: "Fully furnished 1 BHK at Kamal Pushpa", locality: "Bandra West", price: "₹80,000 / month", facts: "1 BHK · Fully furnished · OC", freshness: "Updated 21h ago", href: "/listings/1-bhk-for-rent-kamal-pushpa-bandra-west-9503/9503" },
  { city: "Mumbai", assetClass: "Residential", transaction: "Rent", title: "1 BHK at Himmat Ghar, 13th Road", locality: "Khar West", price: "Price on request", facts: "1 BHK · Carpet area on enquiry", freshness: "Updated 21h ago", href: "/listings/1-bhk-for-rent-himmat-ghar-13th-rd-khar-west-9500/9500" },
  { city: "Mumbai", assetClass: "Residential", transaction: "Rent", title: "2 BHK for rent", locality: "Mumbai", price: "Price on request", facts: "2 BHK · Carpet area on enquiry", freshness: "Updated yesterday", href: "/listings/2-bhk-for-rent-9474/9474" },
  { city: "Mumbai", assetClass: "Commercial", transaction: "Sale", title: "Office space for sale in BKC", locality: "BKC, Mumbai", price: "₹12.80 Cr", facts: "2,140 sqft · Fitted · OC", freshness: "Updated 2h ago", href: "/listings/office-space-for-sale-bkc-4101/4101" },
  { city: "Mumbai", assetClass: "Commercial", transaction: "Rent", title: "Retail space for rent on Linking Road", locality: "Bandra West, Mumbai", price: "₹4.25L / month", facts: "1,180 sqft · Ground floor · Jodi possible", freshness: "Updated 5h ago", href: "/listings/retail-space-for-rent-linking-road-4102/4102" },
  { city: "Bengaluru", assetClass: "Residential", transaction: "Sale", title: "3 BHK with garden view", locality: "Indiranagar, Bengaluru", price: "₹2.15 Cr", facts: "3 BHK · 1,620 sqft · Ready to move", freshness: "Updated 3h ago", href: "/listings/3-bhk-sale-indiranagar-5201/5201" },
  { city: "Bengaluru", assetClass: "Commercial", transaction: "Rent", title: "Flexible office floor near Koramangala", locality: "Koramangala, Bengaluru", price: "₹3.10L / month", facts: "2,600 sqft · Furnished · Parking", freshness: "Updated 8h ago", href: "/listings/office-rent-koramangala-5202/5202" },
  { city: "Pune", assetClass: "Residential", transaction: "Rent", title: "2 BHK in Koregaon Park", locality: "Koregaon Park, Pune", price: "₹62,000 / month", facts: "2 BHK · Fully furnished · Balcony", freshness: "Updated 1h ago", href: "/listings/2-bhk-rent-koregaon-park-6201/6201" },
  { city: "Pune", assetClass: "Commercial", transaction: "Rent", title: "Retail space for rent in Baner", locality: "Baner, Pune", price: "₹1.45L / month", facts: "980 sqft · Street-facing · OC", freshness: "Updated 4h ago", href: "/listings/retail-rent-baner-6202/6202" },
];

const cityOptions = Object.keys(marketData) as City[];
const assetOptions: AssetClass[] = ["All", "Residential", "Commercial"];
const defaultSuggestions = [
  "2 BHK in {locality} under ₹1.5L",
  "Office space for sale in BKC",
  "Retail space for rent in Pune",
];

function Logo() {
  return (
    <Link href="/" className="flex items-center gap-2.5" aria-label="PropAI home">
      <span className="brand-mark-wrap"><img src={signalMark} alt="" className="brand-mark" /></span>
      <span className="brand-wordmark">PropAI<span className="brand-dot">.</span></span>
    </Link>
  );
}

function SectionHeader({ eyebrow, title, body, action }: { eyebrow?: string; title: string; body?: string; action?: React.ReactNode }) {
  return (
    <div className="section-header">
      <div>
        {eyebrow ? <p className="eyebrow mb-3">{eyebrow}</p> : null}
        <h2 className="section-title">{title}</h2>
        {body ? <p className="section-body">{body}</p> : null}
      </div>
      {action}
    </div>
  );
}

export default function Home() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [activeCity, setActiveCity] = useState<City>("Mumbai");
  const [assetClass, setAssetClass] = useState<AssetClass>("All");
  const [query, setQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const market = marketData[activeCity];

  const filteredListings = useMemo(() => listingRecords.filter((listing) => listing.city === activeCity && (assetClass === "All" || listing.assetClass === assetClass)).slice(0, 6), [activeCity, assetClass]);
  const suggestions = defaultSuggestions.map((suggestion) => suggestion.replace("{locality}", market.localityExample));
  const queryPlaceholder = assetClass === "Commercial" ? `e.g. office space near ${market.localityExample}` : `e.g. 2 BHK in ${market.localityExample} under ₹1.5L`;
  const liveBrief = submittedQuery || suggestions[0];

  function handleSearch(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const cleanQuery = query.trim() || liveBrief;
    setSubmittedQuery(cleanQuery);
    toast.success("Search brief saved", { description: `Looking for ${cleanQuery} across live broker conversations in ${activeCity}.` });
  }

  function handleSuggestion(value: string) {
    setQuery(value);
    setSubmittedQuery(value);
  }

  function changeCity(city: City) {
    setActiveCity(city);
    setSubmittedQuery("");
    toast(`Showing ${city}`, { description: "The same marketplace structure can switch to another active city." });
  }

  return (
    <div className="min-h-screen overflow-x-hidden bg-[#F8F8F5] text-[#18232B]">
      <header className="site-header">
        <div className="site-header-inner">
          <Logo />
          <nav className="desktop-nav" aria-label="Primary navigation"><a href="#listings">Browse properties</a><a href="#localities">Localities</a><a href="#how-it-works">How it works</a></nav>
          <div className="desktop-actions"><a href="/contact" className="broker-link">Broker login</a><Button asChild className="header-cta"><a href="#search">Find a property <ArrowUpRight size={15} /></a></Button></div>
          <button className="mobile-menu-button" aria-label={mobileOpen ? "Close menu" : "Open menu"} onClick={() => setMobileOpen((open) => !open)}>{mobileOpen ? <X size={21} /> : <Menu size={21} />}</button>
        </div>
        {mobileOpen ? <div className="mobile-nav"><a href="#listings" onClick={() => setMobileOpen(false)}>Browse properties</a><a href="#localities" onClick={() => setMobileOpen(false)}>Localities</a><a href="#how-it-works" onClick={() => setMobileOpen(false)}>How it works</a><a href="/contact">Broker login</a><a href="#search" className="mobile-nav-cta" onClick={() => setMobileOpen(false)}>Find a property <ArrowUpRight size={15} /></a></div> : null}
      </header>

      <main>
        <section className="hero-section" id="search">
          <div className="hero-inner">
            <div className="hero-copy">
              <div className="trust-label"><span className="live-dot" /> Live listings from local broker networks</div>
              <div className="hero-heading-row"><h1>Find the right <em>property</em><br />before it disappears.</h1><div className="market-picker"><span className="picker-label">Current market</span><label htmlFor="city-picker" className="sr-only">Current market</label><select id="city-picker" value={activeCity} onChange={(event) => changeCity(event.target.value as City)}>{cityOptions.map((city) => <option key={city} value={city}>{city}</option>)}</select><ChevronDown size={15} /></div></div>
              <p className="hero-support">Search the conversations where homes and commercial spaces move first. See what is fresh, then go straight to the broker who shared it.</p>

              <form className="search-shell" onSubmit={handleSearch}>
                <div className="search-topline"><label htmlFor="natural-search">Search in plain English</label><span className="command-hint"><span className="keycap">⌘</span> K</span></div>
                <div className="mode-row" role="tablist" aria-label="Asset type"><span className="mode-label">Show me</span>{assetOptions.map((item) => <button key={item} type="button" role="tab" aria-selected={assetClass === item} className={assetClass === item ? "mode-option is-active" : "mode-option"} onClick={() => setAssetClass(item)}>{item}</button>)}</div>
                <div className="search-row"><Search className="search-icon" size={20} /><Input id="natural-search" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={queryPlaceholder} aria-label="Search in plain English" /><Button type="submit" className="search-button">Search <ArrowRight size={16} /></Button></div>
                <p className="search-helper">Try a locality, building, broker, BHK, office, retail space, budget, or a full request.</p>
              </form>

              <div className="suggested-row" aria-label="Suggested searches"><span className="suggested-label">Try a live brief</span>{suggestions.map((suggestion) => <button key={suggestion} type="button" className="suggestion-chip" onClick={() => handleSuggestion(suggestion)}>{suggestion}</button>)}</div>
            </div>

            <Card className="hero-snapshot">
              <div className="snapshot-image-wrap"><img src={heroArchitecture} alt="Layered residential architecture in the current active market" className="snapshot-image" /><div className="snapshot-image-caption"><span className="live-dot" /> Network pulse · {activeCity}</div></div>
              <CardContent className="snapshot-content"><div className="snapshot-heading"><div><p className="eyebrow">Live network</p><h2>Fresh from brokers near you</h2></div><span className="status-pill"><span className="live-dot" /> Live</span></div><div className="snapshot-list">{filteredListings.slice(0, 3).map((listing) => <div key={listing.href} className="snapshot-line"><span><strong>{listing.locality}</strong><small>{listing.assetClass} · {listing.transaction}</small></span><ArrowUpRight size={15} /></div>)}</div><a href="#listings" className="snapshot-link">Explore live inventory <ArrowRight size={15} /></a></CardContent>
            </Card>
          </div>
          <div className="hero-footnote"><span className="pulse-line" /> Just landed · 7m ago: <strong>{liveBrief}</strong> <span className="hero-city">in {activeCity}</span></div>
        </section>

        <section className="snapshot-stats-section" aria-label="Market snapshot"><div className="content-container"><div className="market-label"><span className="eyebrow">Market snapshot · {activeCity}</span><span className="market-rule" /></div><div className="stats-grid"><Card className="stat-card"><CardContent><span className="stat-value">{market.liveToday}</span><span className="stat-label">Fresh listings today</span><span className="stat-note">from active broker chats</span></CardContent></Card><Card className="stat-card"><CardContent><span className="stat-value">{market.localitiesCovered}</span><span className="stat-label">Localities covered</span><span className="stat-note">across {activeCity}</span></CardContent></Card><Card className="stat-card"><CardContent><span className="stat-value">100%</span><span className="stat-label">Verified broker network</span><span className="stat-note">real conversations only</span></CardContent></Card><Card className="stat-card"><CardContent><span className="stat-value">1 tap</span><span className="stat-label">WhatsApp-first enquiries</span><span className="stat-note">no anonymous forms</span></CardContent></Card></div></div></section>

        <section className="section-block listings-section" id="listings"><div className="content-container"><SectionHeader eyebrow="Fresh inventory" title="Fresh from brokers near you" body="Live residential and commercial listings sourced from active broker conversations, with freshness tracked every day." action={<a className="text-link" href="/search">View all listings <ArrowRight size={16} /></a>} /><div className="listing-grid">{filteredListings.map((listing, index) => <Card key={listing.href} className="listing-card" style={{ "--card-delay": `${index * 45}ms` } as React.CSSProperties}><CardContent className="listing-card-content"><div className="listing-topline"><Badge className={listing.transaction === "Sale" ? "badge-sale" : "badge-rent"}>{listing.assetClass} · {listing.transaction}</Badge><span className="fresh-tag"><span className="live-dot" /> Fresh</span></div><div className="listing-title-row"><h3>{listing.title}</h3><ArrowUpRight className="listing-arrow" size={18} /></div><p className="listing-locality"><span className="pin-mark">⌖</span>{listing.locality}</p><p className="listing-price">{listing.price}</p><p className="listing-facts">{listing.facts}</p><div className="listing-footer"><span className="freshness"><Clock3 size={14} /> {listing.freshness}</span><a href={listing.href} className="view-link">View property <ArrowRight size={15} /></a></div></CardContent></Card>)}</div>{filteredListings.length === 0 ? <div className="empty-listings"><p className="eyebrow">No matching inventory in this view yet</p><h3>Try another asset type or broaden the brief.</h3><Button variant="outline" onClick={() => setAssetClass("All")}>Show all inventory</Button></div> : null}<div className="center-link-wrap"><a href="/search" className="outline-link">Load more listings <ArrowDownRight size={16} /></a></div></div></section>

        <section className="section-block locality-section" id="localities"><div className="content-container"><SectionHeader eyebrow="Places worth knowing" title="Browse by locality" body={`Start with a neighbourhood in ${activeCity}, then narrow by brief, budget, and the details that matter on the ground.`} action={<a className="text-link" href="/localities">All localities <ArrowRight size={16} /></a>} /><div className="locality-layout"><Card className="locality-feature-card"><img src={localityTexture} alt="Residential streets and apartment facades in the active market" className="locality-feature-image" /><CardContent><p className="eyebrow">City guide</p><h3>Good properties are local.</h3><p>Follow the streets you already know, or let the live network show you a nearby pocket worth a look.</p><a href="/localities" className="feature-link">Explore all neighbourhoods <ArrowUpRight size={16} /></a></CardContent></Card><div className="locality-grid">{market.localities.map((locality) => <a key={locality.name} href={`/localities/${locality.name.toLowerCase().replaceAll(" ", "-")}`} className="locality-card"><div><h3>{locality.name}</h3><p>{locality.count}</p><small>{locality.detail}</small></div><ChevronRight size={18} /></a>)}</div></div></div></section>

        <section className="section-block process-section" id="how-it-works"><div className="content-container"><SectionHeader eyebrow="A shorter route to the right person" title="How it works" body="No account to create, no portal maze to navigate. Just a useful brief and a direct handoff." /><div className="process-row">{[{ number: "01", icon: <Search size={20} />, title: "Browse live listings", body: "Explore homes and commercial spaces from active broker conversations, not stale portal uploads." }, { number: "02", icon: <Send size={20} />, title: "Send an enquiry", body: "Share your brief in one tap. Your enquiry lands with the broker who shared the listing." }, { number: "03", icon: <MessagesSquare size={20} />, title: "Continue on WhatsApp", body: "Ask for current photos, OC details, carpet area, Jodi options, or the next viewing directly." }].map((step, index) => <div className="process-step" key={step.number}><div className="step-number">{step.number}</div><div className="step-icon">{step.icon}</div><h3>{step.title}</h3><p>{step.body}</p>{index < 2 ? <div className="step-connector" /> : null}</div>)}</div></div></section>

        <section className="trust-section"><div className="content-container trust-layout"><div className="trust-intro"><p className="eyebrow">Why PropAI?</p><h2>Real inventory needs a real trail.</h2><p>Property search gets better when you can see where the listing came from, how fresh it is, and who to speak to next.</p><a href="/about" className="text-link">Read how PropAI works <ArrowRight size={16} /></a></div><div className="trust-list">{[{ icon: <MessagesSquare size={19} />, title: "Real broker conversations", body: "Inventory comes from local WhatsApp broker networks, not anonymous uploads." }, { icon: <Clock3 size={19} />, title: "Freshness tracking", body: "Listings update regularly and stale inventory is hidden after 30 days." }, { icon: <ShieldCheck size={19} />, title: "Direct WhatsApp connection", body: "Move from a useful property brief to a verified broker without the lead-form detour." }, { icon: <Check size={19} />, title: "No fake inventory", body: "No stock photography, no invented availability, and no fake reviews to create false confidence." }].map((item) => <div className="trust-item" key={item.title}><div className="trust-icon">{item.icon}</div><div><h3>{item.title}</h3><p>{item.body}</p></div></div>)}</div></div></section>

        <section className="final-cta-section"><div className="content-container final-cta-card"><div><p className="eyebrow">Your next move</p><h2>Looking for something specific?</h2><p>Tell us the city, locality, budget, BHK, or the small detail that makes a place feel right.</p></div><div className="final-cta-actions"><a href="#search" className="primary-cta">Search again <ArrowUpRight size={17} /></a><a href="/contact" className="secondary-cta"><MessagesSquare size={17} /> Send a WhatsApp enquiry</a></div></div></section>
      </main>

      <footer className="site-footer"><div className="content-container footer-top"><div className="footer-brand"><Logo /><p>Live property inventory, with a direct line to the broker.</p></div><div className="footer-links"><div><p className="footer-label">Browse</p><a href="/search">Search listings</a><a href="/map">Property map</a><a href="/localities">All localities</a></div><div><p className="footer-label">For brokers</p><a href="/contact">Broker login</a><a href="/contact">List with PropAI</a><a href="/about">How it works</a></div><div><p className="footer-label">About PropAI</p><a href="/about">About us</a><a href="/contact">Contact</a><a href="/about#no-photos">Why no photos</a></div><div><p className="footer-label">Privacy</p><a href="/privacy">Privacy</a><a href="/data-deletion">Data deletion</a><a href="/terms">Terms</a></div></div></div><div className="content-container footer-bottom"><span>© 2026 PropAI. Inventory sourced from local broker networks.</span><span className="footer-status"><span className="live-dot" /> {activeCity} · Live market</span></div></footer>
    </div>
  );
}
