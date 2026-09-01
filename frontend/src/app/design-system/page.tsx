import { Building2, Clock3, MapPin, MessageSquare, Ruler } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { ListingHeadline } from "@/components/ui/listing-headline";
import { PillRow } from "@/components/ui/pill-row";
import { PriceDisplay } from "@/components/ui/price-display";
import { StatusBadge } from "@/components/ui/badge";

export default function DesignSystemPage() {
  return (
    <main className="propai-design-system-page" data-design-system="monsoon-market-board">
      <header className="propai-design-system-header">
        <p className="propai-kicker">PropAI / interface system</p>
        <h1>Monsoon Market Board</h1>
        <p>Primitive components for the dense internal register and the calm public register. This page is a review surface; it does not represent live inventory.</p>
      </header>

      <div className="propai-design-system-grid">
        <Card className="propai-design-system-span-2">
          <CardHeader><CardTitle>Card + Market Rail</CardTitle><p className="propai-design-system-note">Solid surface, sharp border, source-to-action spine.</p></CardHeader>
          <CardContent>
            <div className="propai-demo-listing">
              <div className="propai-market-rail" aria-hidden="true" />
              <div className="propai-demo-listing-main">
                <div className="propai-demo-meta"><span data-structured="true">Availability update · 04:57</span><StatusBadge tone="verified" /></div>
                <ListingHeadline title="3 BHK in Lodha Sea View" />
                <p className="propai-demo-location"><MapPin aria-hidden="true" /> Bandra West · source location</p>
                <PillRow items={[{ label: "Residential", tone: "teal" }, { label: "Rent", tone: "neutral" }, { label: "WhatsApp-linked", tone: "lime" }]} />
                <div className="propai-demo-facts"><PriceDisplay value="₹85,000 / month" /><span><Ruler aria-hidden="true" /> 1,250 sqft</span><span><Clock3 aria-hidden="true" /> Active today</span></div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Status / trust badges</CardTitle><p className="propai-design-system-note">Color is paired with a readable evidence state.</p></CardHeader>
          <CardContent><div className="propai-demo-stack"><StatusBadge tone="verified" /><StatusBadge tone="needs-review" /><StatusBadge tone="flagged" /></div></CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Price display</CardTitle><p className="propai-design-system-note">Mono for money; no blank price gaps.</p></CardHeader>
          <CardContent><div className="propai-price-demo"><PriceDisplay value="₹2.25 Cr" /><PriceDisplay value="₹85,000 / month" /><PriceDisplay /></div></CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Listing headline</CardTitle><p className="propai-design-system-note">Unavailable is distinct from a real title.</p></CardHeader>
          <CardContent><ListingHeadline title="Lodha Sea View · 3 BHK" /><ListingHeadline className="mt-4" /></CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Pill row</CardTitle><p className="propai-design-system-note">One compact vocabulary for listing context.</p></CardHeader>
          <CardContent><PillRow items={[{ label: "Residential", tone: "teal" }, { label: "Commercial", tone: "teal" }, { label: "Sale", tone: "neutral" }, { label: "Fresh", tone: "lime" }, { label: "Needs review", tone: "amber" }, { label: "Flagged", tone: "vermilion" }]} /></CardContent>
        </Card>

        <Card className="propai-design-system-span-2">
          <CardHeader><CardTitle>Empty and incomplete data states</CardTitle><p className="propai-design-system-note">Missing fields remain visible and explainable.</p></CardHeader>
          <CardContent><div className="propai-empty-demo-grid"><EmptyState field="address" /><EmptyState field="locality" /><EmptyState field="price" /><EmptyState field="title" compact /></div></CardContent>
        </Card>
      </div>

      <footer className="propai-design-system-footer"><MessageSquare aria-hidden="true" /> Source-grounded UI · prices, area, timestamps, and status use IBM Plex Mono.</footer>
    </main>
  );
}
