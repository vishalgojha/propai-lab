/* Design direction: Mumbai Editorial Utility — listing detail pages use a calm editorial reading flow, visible provenance, clear specifications, and a direct broker handoff. */

import { Link, useRoute } from "wouter";
import { ArrowLeft, ArrowRight, ArrowUpRight, Check, Clock3, MapPin, MessagesSquare, ShieldCheck, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { listingById, listingDetails, type ListingDetail } from "@/lib/listingData";

const signalMark = "/manus-storage/propai-signal-mark_74a178d6.png";

function Logo() {
  return <Link href="/" className="flex items-center gap-2.5" aria-label="PropAI home"><span className="brand-mark-wrap"><img src={signalMark} alt="" className="brand-mark" /></span><span className="brand-wordmark">PropAI<span className="brand-dot">.</span></span></Link>;
}

function WhatsAppButton({ listing, compact = false }: { listing: ListingDetail; compact?: boolean }) {
  function handleEnquiry() {
    toast.success("WhatsApp enquiry ready", { description: `Your enquiry for “${listing.title}” can now be routed to the ${listing.city} broker.` });
  }
  return <Button className={compact ? "detail-whatsapp detail-whatsapp-compact" : "detail-whatsapp"} onClick={handleEnquiry}><MessagesSquare size={compact ? 16 : 18} /> {compact ? "Enquire" : "Continue on WhatsApp"} <ArrowUpRight size={15} /></Button>;
}

function DetailVisual({ listing }: { listing: ListingDetail }) {
  return <div className={listing.kind === "Commercial" ? "detail-visual detail-visual-commercial" : "detail-visual detail-visual-residential"}>
    <div className="detail-visual-grid" />
    <div className="detail-visual-copy"><span className="eyebrow">{listing.kind} · {listing.transaction}</span><strong>{listing.city}</strong><span>{listing.locality}</span></div>
    <div className="detail-visual-stamp"><Sparkles size={14} /> Live brief</div>
  </div>;
}

function DetailPage({ listing }: { listing: ListingDetail }) {
  const related = listingDetails.filter((item) => item.id !== listing.id && item.kind === listing.kind).slice(0, 3);
  return <div className="detail-page min-h-screen bg-[#F8F8F5] text-[#18232B]">
    <header className="site-header"><div className="site-header-inner"><Logo /><nav className="desktop-nav" aria-label="Detail navigation"><a href="/#listings">Browse properties</a><a href="/#localities">Localities</a><a href="/#how-it-works">How it works</a></nav><div className="desktop-actions"><a href="/contact" className="broker-link">Broker login</a><Button asChild className="header-cta"><a href="/#search">Find a property <ArrowUpRight size={15} /></a></Button></div><Link href="/" className="detail-back-mobile"><ArrowLeft size={18} /></Link></div></header>
    <main>
      <div className="detail-breadcrumb-wrap"><div className="content-container detail-breadcrumb"><Link href="/" className="back-link"><ArrowLeft size={15} /> Back to listings</Link><span>/</span><span>{listing.city}</span><span>/</span><span>{listing.kind}</span></div></div>
      <section className="detail-hero"><div className="content-container detail-hero-grid"><div className="detail-hero-copy"><div className="detail-badges"><Badge className={listing.transaction === "Sale" ? "badge-sale" : "badge-rent"}>{listing.kind} · {listing.transaction}</Badge><span className="fresh-tag"><span className="live-dot" /> {listing.freshness}</span></div><h1>{listing.title}</h1><p className="detail-location"><MapPin size={17} /> {listing.locality}</p><p className="detail-summary">{listing.summary}</p><div className="detail-price-row"><div><span className="detail-price">{listing.price}</span><span className="detail-price-note">{listing.priceNote}</span></div><WhatsAppButton listing={listing} /></div><div className="detail-source"><ShieldCheck size={16} /><span><strong>{listing.source}</strong><small>Inventory is sourced from local broker conversations.</small></span></div></div><DetailVisual listing={listing} /></div></section>

      <section className="detail-body"><div className="content-container detail-body-grid"><div><Card className="overview-card"><CardContent><div className="detail-card-heading"><div><p className="eyebrow">At a glance</p><h2>Property details</h2></div><span className="detail-live-mark"><span className="live-dot" /> Live</span></div><div className="overview-grid">{listing.overview.map((item) => <div className="overview-item" key={item.label}><span>{item.label}</span><strong>{item.value}</strong></div>)}</div></CardContent></Card><div className="highlights-block"><p className="eyebrow">What to ask for</p><h2>Useful details, not filler.</h2><div className="highlight-list">{listing.highlights.map((highlight) => <div key={highlight}><span className="highlight-check"><Check size={14} /></span><span>{highlight}</span></div>)}</div></div></div><aside className="detail-aside"><Card className="enquiry-card"><CardContent><p className="eyebrow">Direct handoff</p><h2>Speak with the broker who shared this.</h2><p>Ask for current photos, videos, carpet area, OC, Jodi options, or a viewing window. The conversation continues on WhatsApp.</p><WhatsAppButton listing={listing} /><p className="enquiry-note"><Clock3 size={14} /> {listing.freshness}</p></CardContent></Card><div className="broker-note"><p className="eyebrow">Source note</p><p>{listing.brokerNote}</p></div></aside></div></section>

      <section className="related-section"><div className="content-container"><div className="related-heading"><div><p className="eyebrow">Keep exploring</p><h2>More {listing.kind.toLowerCase()} properties</h2></div><Link href="/#listings" className="text-link">Browse all listings <ArrowRight size={16} /></Link></div><div className="related-grid">{related.map((item) => <Link className="related-card" key={item.id} href={`/listings/${item.slug}/${item.id}`}><div><Badge className={item.transaction === "Sale" ? "badge-sale" : "badge-rent"}>{item.transaction}</Badge><h3>{item.title}</h3><p>{item.locality}</p><strong>{item.price}</strong></div><ArrowUpRight size={17} /></Link>)}</div></div></section>
    </main>
    <footer className="site-footer"><div className="content-container footer-top"><div className="footer-brand"><Logo /><p>Live property inventory, with a direct line to the broker.</p></div><div className="footer-links"><div><p className="footer-label">Browse</p><a href="/#listings">Search listings</a><a href="/map">Property map</a><a href="/localities">All localities</a></div><div><p className="footer-label">For brokers</p><a href="/contact">Broker login</a><a href="/contact">List with PropAI</a><a href="/about">How it works</a></div><div><p className="footer-label">About PropAI</p><a href="/about">About us</a><a href="/contact">Contact</a><a href="/about#no-photos">Why no photos</a></div><div><p className="footer-label">Privacy</p><a href="/privacy">Privacy</a><a href="/data-deletion">Data deletion</a><a href="/terms">Terms</a></div></div></div><div className="content-container footer-bottom"><span>© 2026 PropAI. Inventory sourced from local broker networks.</span><span className="footer-status"><span className="live-dot" /> {listing.city} · Live market</span></div></footer>
  </div>;
}

export default function ListingPage() {
  const [, params] = useRoute("/listings/:slug/:id");
  const listing = listingById[params?.id ?? ""] ?? listingDetails[0];
  return <DetailPage listing={listing} />;
}
