import Link from "next/link";
import { ArrowRight, Building2, LineChart, MapPin, Search, Users } from "lucide-react";
import { getPublicDataOverview, formatPublicPrice } from "@/lib/public-data";
import type { ComponentType } from "react";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Explore Live Data — PropAI",
  description:
    "Browse the live data PropAI has so far: localities, buildings, listings, brokers, and recent activity from WhatsApp networks.",
};

function timeAgo(value: string | null): string {
  if (!value) return "Unknown";
  const diff = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(diff) || diff < 0) return "Just now";
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function ActivityChart({
  points,
}: {
  points: Array<{ date: string; messages: number; parsedRecords: number; listings: number }>;
}) {
  const width = 1120;
  const height = 320;
  const padding = { top: 24, right: 20, bottom: 44, left: 44 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const maxValue = Math.max(1, ...points.map((p) => Math.max(p.messages, p.parsedRecords, p.listings)));
  const dayWidth = plotWidth / Math.max(1, points.length);

  const gridLines = [0, 0.25, 0.5, 0.75, 1].map((ratio) => ({
    y: padding.top + plotHeight - plotHeight * ratio,
    label: Math.round(maxValue * ratio).toString(),
  }));

  return (
    <div className="rounded-3xl border border-white/10 bg-zinc-950/80 p-5 lg:p-6">
      <div className="flex flex-col gap-2 lg:flex-row lg:items-end lg:justify-between mb-4">
        <div>
          <div className="inline-flex items-center gap-2 text-xs uppercase tracking-wider text-zinc-500">
            <LineChart className="h-3.5 w-3.5 text-green-400" aria-hidden={true} />
            14-day activity
          </div>
          <h2 className="mt-2 text-lg font-semibold text-white">Messages, parsed records, and listings</h2>
          <p className="text-sm text-zinc-500">The live capture pipeline over the last two weeks.</p>
        </div>
        <div className="flex flex-wrap gap-3 text-xs text-zinc-400">
          <span className="inline-flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full bg-green-400" />
            Messages
          </span>
          <span className="inline-flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full bg-cyan-400" />
            Parsed
          </span>
          <span className="inline-flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full bg-amber-400" />
            Listings
          </span>
        </div>
      </div>

      <div className="overflow-x-auto">
        <svg viewBox={`0 0 ${width} ${height}`} className="w-full min-w-[720px] h-[320px]" role="img" aria-label="Activity chart for the last 14 days">
          {gridLines.map((line) => (
            <g key={line.y}>
              <line
                x1={padding.left}
                x2={width - padding.right}
                y1={line.y}
                y2={line.y}
                stroke="rgba(255,255,255,0.08)"
                strokeDasharray="4 6"
              />
              <text x={padding.left - 8} y={line.y + 4} textAnchor="end" fontSize="11" fill="rgba(161,161,170,0.9)">
                {line.label}
              </text>
            </g>
          ))}

          {points.map((point, index) => {
            const x = padding.left + index * dayWidth + dayWidth * 0.18;
            const groupWidth = dayWidth * 0.64;
            const slot = groupWidth / 3;
            const messageH = (point.messages / maxValue) * plotHeight;
            const parsedH = (point.parsedRecords / maxValue) * plotHeight;
            const listingH = (point.listings / maxValue) * plotHeight;
            const baseY = padding.top + plotHeight;
            const date = new Date(point.date);
            const label = `${date.getMonth() + 1}/${date.getDate()}`;

            return (
              <g key={point.date}>
                <rect x={x} y={baseY - messageH} width={slot - 3} height={messageH} rx="6" fill="#3EE88A" />
                <rect x={x + slot} y={baseY - parsedH} width={slot - 3} height={parsedH} rx="6" fill="#22d3ee" />
                <rect x={x + slot * 2} y={baseY - listingH} width={slot - 3} height={listingH} rx="6" fill="#f59e0b" />
                <text x={x + groupWidth / 2} y={height - 14} textAnchor="middle" fontSize="11" fill="rgba(161,161,170,0.9)">
                  {label}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}

export default async function ExplorePage() {
  const overview = await getPublicDataOverview();
  type StatCard = {
    label: string;
    value: number;
    icon: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  };
  const statCards: StatCard[] = [
    { label: "Localities", value: overview.counts.localities, icon: MapPin },
    { label: "Buildings", value: overview.counts.buildings, icon: Building2 },
    { label: "Listings", value: overview.counts.listings, icon: Building2 },
    { label: "Brokers", value: overview.counts.brokers, icon: Users },
    { label: "Raw messages", value: overview.counts.raw_messages, icon: Users },
    { label: "Parsed records", value: overview.counts.parsed_observations, icon: Users },
  ];

  return (
    <div className="min-h-screen bg-black text-white">
      <main className="max-w-7xl mx-auto px-4 lg:px-6 py-10 lg:py-14">
        <div className="mb-8 flex items-center justify-between gap-4">
          <Link href="/" className="text-sm text-zinc-400 hover:text-white transition-colors">
            <span aria-hidden="true">←</span> Back to home
          </Link>
          <Link href="/search" className="text-sm text-zinc-400 hover:text-white transition-colors">
            Search listings
          </Link>
        </div>

        <section className="max-w-4xl">
          <div className="inline-flex items-center gap-2 rounded-full border border-green-400/20 bg-green-400/10 px-3 py-1 text-xs font-medium text-green-300 mb-4">
            <Search className="h-3.5 w-3.5" aria-hidden="true" />
            Full public data hub
          </div>
          <h1 className="text-[32px] lg:text-[48px] leading-[1.05] font-bold text-white max-w-3xl">
            Everything we&apos;ve captured so far, in one place.
          </h1>
          <p className="mt-4 text-[15px] lg:text-[18px] text-zinc-400 max-w-3xl">
            This page surfaces the live market data behind PropAI&apos;s public site: localities, buildings, listings, and broker activity.
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <Link
              href="/search"
              className="inline-flex items-center gap-2 rounded-full bg-green-400 px-5 py-3 text-sm font-semibold text-black hover:bg-green-300 transition-colors"
            >
              Search naturally
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </Link>
            <Link
              href="/localities"
              className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-zinc-900/80 px-5 py-3 text-sm text-zinc-200 hover:border-green-400/40 hover:text-white transition-colors"
            >
              Browse localities
            </Link>
          </div>
        </section>

        <section className="mt-10 grid grid-cols-2 lg:grid-cols-6 gap-3 lg:gap-4">
          {statCards.map(({ label, value, icon: Icon }) => (
            <div key={label} className="rounded-2xl border border-white/10 bg-zinc-950/80 p-4 lg:p-5">
              <Icon className="h-5 w-5 text-green-400 mb-3" aria-hidden={true} />
              <div className="text-3xl font-bold text-white">{value.toLocaleString()}</div>
              <div className="mt-1 text-[10px] uppercase tracking-wider text-zinc-500">{label}</div>
            </div>
          ))}
        </section>

        {overview.activity.length > 0 && (
          <section className="mt-10">
            <ActivityChart points={overview.activity} />
          </section>
        )}

        <section className="mt-12 grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="rounded-3xl border border-white/10 bg-zinc-950/80 p-5 lg:p-6">
            <div className="flex items-center justify-between gap-3 mb-4">
              <div>
                <h2 className="text-lg font-semibold text-white">All localities</h2>
                <p className="text-sm text-zinc-500">Sorted by live listing volume</p>
              </div>
              <Link href="/localities" className="text-sm text-zinc-400 hover:text-white transition-colors">
                View all
              </Link>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {overview.topLocalities.map((loc) => (
                <Link
                  key={loc.slug}
                  href={`/localities/${loc.slug}`}
                  className="rounded-2xl border border-white/10 bg-black/70 p-4 hover:border-green-400/30 hover:bg-zinc-900 transition-colors"
                >
                  <div className="font-medium text-white">{loc.locality}</div>
                  <div className="mt-1 text-sm text-zinc-500">{loc.listingCount} active listing{loc.listingCount === 1 ? "" : "s"}</div>
                </Link>
              ))}
            </div>
          </div>

          <div className="rounded-3xl border border-white/10 bg-zinc-950/80 p-5 lg:p-6">
            <div className="flex items-center justify-between gap-3 mb-4">
              <div>
                <h2 className="text-lg font-semibold text-white">All buildings</h2>
                <p className="text-sm text-zinc-500">Live inventory by building</p>
              </div>
              <Link href="/buildings" className="text-sm text-zinc-400 hover:text-white transition-colors">
                View all
              </Link>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {overview.topBuildings.map((building) => (
                <Link
                  key={building.name}
                  href={`/search?q=${encodeURIComponent(building.name)}`}
                  className="rounded-2xl border border-white/10 bg-black/70 p-4 hover:border-green-400/30 hover:bg-zinc-900 transition-colors"
                >
                  <div className="font-medium text-white">{building.name}</div>
                  <div className="mt-1 text-sm text-zinc-500">{building.listingCount} listing{building.listingCount === 1 ? "" : "s"}</div>
                  <div className="mt-1 text-xs text-zinc-500">{building.microMarket || "Market pending"}</div>
                </Link>
              ))}
            </div>
          </div>
        </section>

        <section className="mt-12">
          <div className="flex items-center justify-between gap-3 mb-4">
            <div>
              <h2 className="text-lg font-semibold text-white">Recent listings</h2>
              <p className="text-sm text-zinc-500">Latest listings captured from broker groups</p>
            </div>
            <Link href="/search" className="text-sm text-zinc-400 hover:text-white transition-colors">
              Search them
            </Link>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 lg:gap-6">
            {overview.recentListings.map((row) => (
              <article key={row.id} className="rounded-3xl border border-white/10 bg-zinc-950/80 p-5 lg:p-6">
                <div className="flex items-start justify-between gap-3 mb-3">
                  <div>
                    <h3 className="text-lg font-semibold text-white">
                      {row.building_name || row.location_label || row.landmark_name || row.micro_market || "Listing"}
                    </h3>
                    <p className="mt-1 text-sm text-zinc-500">{row.micro_market || "Market pending"}</p>
                  </div>
                  {row.micro_market && (
                    <Link
                      href={`/localities/${row.micro_market.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}`}
                      className="inline-flex items-center gap-1 rounded-full border border-white/10 px-2.5 py-1 text-[11px] text-zinc-400 hover:border-green-400/30 hover:text-green-200 transition-colors"
                    >
                      <MapPin className="h-3.5 w-3.5" aria-hidden="true" />
                      Locality
                    </Link>
                  )}
                </div>
                <div className="flex flex-wrap gap-2 mb-4">
                  {row.bhk && <span className="rounded-full border border-white/10 bg-zinc-900 px-3 py-1 text-xs text-zinc-300">{row.bhk}</span>}
                  <span className="rounded-full border border-white/10 bg-zinc-900 px-3 py-1 text-xs text-zinc-300">
                    {formatPublicPrice(row.price, row.price_unit)}
                  </span>
                  {row.furnishing && <span className="rounded-full border border-white/10 bg-zinc-900 px-3 py-1 text-xs text-zinc-300">{row.furnishing}</span>}
                </div>
                <div className="space-y-2 text-sm text-zinc-400">
                  <p><span className="text-zinc-500">Broker:</span> {row.broker_name || "Unknown"}</p>
                  <p><span className="text-zinc-500">Seen:</span> {timeAgo(row.last_seen)}</p>
                  <p><span className="text-zinc-500">Mentions:</span> {row.observation_count ?? 0}</p>
                </div>
              </article>
            ))}
          </div>
        </section>

        <section className="mt-12">
          <div className="flex items-center justify-between gap-3 mb-4">
            <div>
              <h2 className="text-lg font-semibold text-white">Top brokers</h2>
              <p className="text-sm text-zinc-500">By captured WhatsApp activity</p>
            </div>
            <Link href="/search?q=broker" className="text-sm text-zinc-400 hover:text-white transition-colors">
              Search brokers
            </Link>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
            {overview.topBrokers.map((broker) => (
              <div key={broker.canonical_name} className="rounded-3xl border border-white/10 bg-zinc-950/80 p-5">
                <div className="font-medium text-white">{broker.canonical_name}</div>
                <div className="mt-1 text-sm text-zinc-500">{broker.primary_phone || "No phone"}</div>
                <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <div className="text-zinc-500 text-xs uppercase tracking-wider">Posts</div>
                    <div className="text-white">{broker.observation_count ?? 0}</div>
                  </div>
                  <div>
                    <div className="text-zinc-500 text-xs uppercase tracking-wider">Listings</div>
                    <div className="text-white">{broker.listing_count ?? 0}</div>
                  </div>
                  <div>
                    <div className="text-zinc-500 text-xs uppercase tracking-wider">Requirements</div>
                    <div className="text-white">{broker.requirement_count ?? 0}</div>
                  </div>
                  <div>
                    <div className="text-zinc-500 text-xs uppercase tracking-wider">Markets</div>
                    <div className="text-white">{broker.market_count ?? 0}</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}
