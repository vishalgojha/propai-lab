"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import * as api from "@/lib/api";

interface Suggestion {
  id: number;
  agent: string;
  suggestion_type: string;
  title: string;
  description: string;
  source_data: any;
  proposal_data: any;
  confidence: number;
  status: string;
  rejection_reason: string | null;
  created_at: string;
}

interface MemoryStats {
  aliases_learned: number;
  building_aliases: number;
  broker_aliases: number;
  brokers_merged: number;
  buildings_discovered: number;
  locations_mapped: number;
  total_approved: number;
  total_rejected: number;
  total_suggestions: number;
  total_ai_calls: number;
  estimated_ai_calls_avoided: number;
}

interface UsageStats {
  period_days: number;
  calls: number;
  tokens_input: number;
  tokens_output: number;
  cost_usd: number;
  today_calls: number;
  today_tokens_input: number;
  today_tokens_output: number;
  today_cost_usd: number;
}

interface ListingResult {
  fingerprint: string;
  intent: string;
  bhk: string;
  price: number;
  price_formatted: string;
  area_sqft: number;
  furnishing: string;
  location_label: string;
  building_name: string;
  landmark_name: string;
  micro_market: string;
  developer: string;
  broker_name: string;
  broker_phone: string;
  first_seen: string;
  first_seen_text: string;
  last_seen: string;
  last_seen_text: string;
  observation_count: number;
  group_count: number;
  confidence: number;
  latest_message: string;
  latest_group: string;
  latest_timestamp: string;
  latest_sender: string;
  raw_message_id: number;
  match_reasons: string[];
}

interface ListingSearchResults {
  type: "listing_results";
  total: number;
  results: ListingResult[];
  grouped: Record<string, { rentals: number; sales: number; listings: ListingResult[] }>;
  showing: number;
  offset: number;
  has_more: boolean;
  remaining: number;
  search_summary: {
    total: number;
    brokers: number;
    buildings: number;
    groups: number;
  };
  suggestion?: string;
}

const AGENT_ICONS: Record<string, string> = {
  duplicate_listing: "🔄",
  merge_broker: "👤",
  alias: "🏷️",
  location: "📍",
  building: "🏢",
  price: "💰",
  quality: "✅",
  requirement: "📋",
};

const AGENT_LABELS: Record<string, string> = {
  duplicate_listing: "Duplicate",
  merge_broker: "Merge",
  alias: "Alias",
  location: "Location",
  building: "Building",
  price: "Price",
  quality: "Quality",
  requirement: "Requirement",
};

const DETERMINISTIC_AGENTS = new Set(["duplicate_listing", "merge_broker", "price"]);

function evidenceLines(s: Suggestion): string[] {
  const lines: string[] = [];
  const src = s.source_data || {};
  const agent = s.agent;
  if (agent === "duplicate_listing" && src.listings) {
    lines.push(`✓ ${src.listings.length} listings share same broker + bhk`);
    if (src.broker) lines.push(`✓ Same broker: ${src.broker}`);
    if (src.building) lines.push(`✓ Same building: ${src.building}`);
    if (src.confidence_reason) lines.push(`✓ ${src.confidence_reason}`);
  } else if (agent === "merge_broker") {
    if (src.match_count) lines.push(`✓ Seen ${src.match_count}x with same phone`);
    if (src.names) lines.push(`✓ Known as: ${src.names.join(", ")}`);
    if (src.phones) lines.push(`✓ Phones: ${src.phones.join(", ")}`);
    if (src.confidence_reason) lines.push(`✓ ${src.confidence_reason}`);
  } else if (agent === "alias") {
    if (src.occurrences) lines.push(`✓ "${src.alias}" seen ${src.occurrences}x`);
    if (src.match_count) lines.push(`✓ ${src.match_count} matching references`);
    if (src.canonical) lines.push(`✓ Maps to: ${src.canonical}`);
  } else if (agent === "building") {
    if (src.parsed_id) lines.push(`✓ From message #${src.parsed_id}`);
    if (src.building_name) lines.push(`✓ Building: ${src.building_name}`);
    if (src.micro_market) lines.push(`✓ Market: ${src.micro_market}`);
  } else if (agent === "location") {
    if (src.parsed_id) lines.push(`✓ From message #${src.parsed_id}`);
    if (src.micro_market) lines.push(`✓ Location: ${src.micro_market}`);
  } else if (agent === "price") {
    if (src.micro_market) lines.push(`✓ Market: ${src.micro_market}`);
    if (src.bhk) lines.push(`✓ BHK: ${src.bhk}`);
    if (src.price) lines.push(`✓ Price: ₹${src.price?.toLocaleString()}`);
    if (src.median) lines.push(`✓ Market median: ₹${src.median?.toLocaleString()}`);
    if (src.count) lines.push(`✓ ${src.count} comparable listings`);
  }
  return lines;
}

function impactLines(s: Suggestion): string[] {
  const lines: string[] = [];
  const prop = s.proposal_data || {};
  const action = prop.action || "";
  if (action === "merge_listings") {
    lines.push(`Will merge 2 duplicate listings into 1`);
    if (s.source_data?.observation_count) lines.push(`Links ${s.source_data.observation_count} total posts`);
  } else if (action === "merge_brokers") {
    lines.push("Will merge 2 broker profiles into 1");
    if (s.source_data?.obs_count) lines.push(`Links ${s.source_data.obs_count} posts`);
  } else if (action === "create_alias") {
    lines.push(`Keeps "${prop.alias}" connected to "${prop.canonical}"`);
    lines.push("~3 AI calls avoided per future match");
  } else if (s.agent === "building") {
    lines.push("New building profile for future matches");
  } else if (s.agent === "location") {
    lines.push("New location profile for future matches");
  } else if (s.agent === "price") {
    lines.push("Price outlier — may indicate parse error or genuine deal");
  }
  return lines;
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function ListingCard({ listing }: { listing: ListingResult }) {
  const [expanded, setExpanded] = useState(false);

  const intentColor = listing.intent === "RENT" ? "text-blue-400" : listing.intent === "SELL" ? "text-green-400" : "text-yellow-400";
  const intentBg = listing.intent === "RENT" ? "bg-blue-500/10" : listing.intent === "SELL" ? "bg-green-500/10" : "bg-yellow-500/10";

  return (
    <div className="bg-[#0d1117] border border-[rgba(255,255,255,0.06)] rounded-xl p-4 hover:border-blue-500/30 transition-all">
      {/* Header: Building + Price */}
      <div className="flex items-start justify-between mb-2">
        <div>
          <h3 className="text-sm font-semibold text-white">{listing.building_name}</h3>
          <div className="text-[10px] text-[#64748b]">{listing.micro_market}</div>
        </div>
        <div className="text-right">
          <div className="text-sm font-bold text-white">{listing.price_formatted}</div>
          {listing.area_sqft && <div className="text-[10px] text-[#64748b]">{listing.area_sqft} sqft</div>}
        </div>
      </div>

      {/* Details Grid */}
      <div className="grid grid-cols-3 gap-2 mb-2 text-[11px]">
        <div>
          <span className="text-[#64748b]">BHK</span>
          <span className="ml-1 text-white font-medium">{listing.bhk || "—"}</span>
        </div>
        <div>
          <span className="text-[#64748b]">Furnishing</span>
          <span className="ml-1 text-white font-medium">{listing.furnishing || "—"}</span>
        </div>
        <div>
          <span className={`font-semibold px-1.5 py-0.5 rounded ${intentColor} ${intentBg}`}>
            {listing.intent}
          </span>
        </div>
      </div>

      {/* Broker + Confidence */}
      <div className="flex items-center justify-between text-[10px] text-[#94a3b8] mb-2">
        <span>Broker: <span className="text-white font-medium">{listing.broker_name || "—"}</span></span>
        <span>Confidence: <span className={`font-medium ${listing.confidence >= 80 ? "text-green-400" : listing.confidence >= 50 ? "text-yellow-400" : "text-red-400"}`}>{listing.confidence}%</span></span>
      </div>

      {/* Timestamps */}
      <div className="flex items-center justify-between text-[10px] text-[#64748b] mb-2">
        <span>{listing.last_seen_text || "Last seen unknown"}</span>
        <span>{listing.first_seen_text || ""}</span>
        <span>Seen {listing.observation_count}x in {listing.group_count} groups</span>
      </div>

      {/* Match Reasons */}
      {listing.match_reasons.length > 0 && (
        <div className="mb-2 p-2 bg-[#161b22] rounded-lg">
          <div className="text-[10px] font-semibold text-[#64748b] uppercase tracking-wider mb-1">Why this result?</div>
          <div className="space-y-0.5">
            {listing.match_reasons.map((reason, i) => (
              <div key={i} className="text-[11px] text-green-400/80">{reason}</div>
            ))}
          </div>
        </div>
      )}

      {/* Traceability */}
      {listing.latest_message && (
        <div className="mb-2 p-2 bg-[#161b22] rounded-lg">
          <div className="text-[10px] font-semibold text-[#64748b] uppercase tracking-wider mb-1">Observed from</div>
          <div className="text-[11px] text-[#94a3b8]">
            WhatsApp: <span className="text-white">{listing.latest_group || "—"}</span>
          </div>
          <div className="text-[11px] text-[#94a3b8]">
            Message: <span className="text-white">&quot;{listing.latest_message}&quot;</span>
          </div>
          <div className="text-[10px] text-[#64748b]">
            {listing.latest_timestamp ? new Date(listing.latest_timestamp).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) : "—"}
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="flex gap-1.5 flex-wrap">
        <button className="text-[10px] px-2 py-1 rounded bg-blue-600/20 text-blue-400 hover:bg-blue-600/30">View</button>
        <button className="text-[10px] px-2 py-1 rounded bg-purple-600/20 text-purple-400 hover:bg-purple-600/30">Open Inventory</button>
        {listing.raw_message_id && (
          <a href={`/observations/${listing.raw_message_id}`} className="text-[10px] px-2 py-1 rounded bg-emerald-600/20 text-emerald-400 hover:bg-emerald-600/30">Original Message</a>
        )}
        <button className="text-[10px] px-2 py-1 rounded bg-amber-600/20 text-amber-400 hover:bg-amber-600/30">Promote</button>
        <button className="text-[10px] px-2 py-1 rounded bg-cyan-600/20 text-cyan-400 hover:bg-cyan-600/30">Connect Broker</button>
      </div>
    </div>
  );
}

function SearchSummary({ results }: { results: ListingSearchResults }) {
  const { search_summary, total, showing, offset, has_more, remaining } = results;
  return (
    <div className="bg-[#0d1117] border border-[rgba(255,255,255,0.06)] rounded-xl p-3 mb-3">
      <div className="flex items-center justify-between mb-2">
        <div className="text-sm font-semibold text-white">
          {total} listing{total !== 1 ? "s" : ""} found
        </div>
        <div className="text-[10px] text-[#64748b]">
          Showing {showing} of {total}
        </div>
      </div>
      <div className="flex flex-wrap gap-3 text-[10px] text-[#94a3b8]">
        <span>{search_summary.brokers} broker{search_summary.brokers !== 1 ? "s" : ""}</span>
        <span>{search_summary.buildings} building{search_summary.buildings !== 1 ? "s" : ""}</span>
        <span>Across {search_summary.groups} WhatsApp group{search_summary.groups !== 1 ? "s" : ""}</span>
      </div>
      {has_more && (
        <div className="mt-2 text-[10px] text-blue-400">
          +{remaining} more listings available
        </div>
      )}
    </div>
  );
}

function EmptyState({ suggestion }: { suggestion?: string }) {
  return (
    <div className="bg-[#0d1117] border border-[rgba(255,255,255,0.06)] rounded-xl p-8 text-center">
      <div className="text-2xl mb-2">🔍</div>
      <div className="text-sm font-semibold text-white mb-2">No exact matches found</div>
      <div className="text-xs text-[#64748b] mb-4">
        {suggestion || "Try different search terms or filters"}
      </div>
      <div className="flex flex-wrap gap-2 justify-center">
        <button className="text-[10px] px-2.5 py-1 rounded border border-[rgba(255,255,255,0.08)] text-[#94a3b8] hover:text-white">Nearby markets</button>
        <button className="text-[10px] px-2.5 py-1 rounded border border-[rgba(255,255,255,0.08)] text-[#94a3b8] hover:text-white">Similar buildings</button>
        <button className="text-[10px] px-2.5 py-1 rounded border border-[rgba(255,255,255,0.08)] text-[#94a3b8] hover:text-white">Different budget</button>
        <button className="text-[10px] px-2.5 py-1 rounded border border-[rgba(255,255,255,0.08)] text-[#94a3b8] hover:text-white">Different BHK</button>
        <button className="text-[10px] px-2.5 py-1 rounded border border-[rgba(255,255,255,0.08)] text-[#94a3b8] hover:text-white">Latest listings</button>
      </div>
    </div>
  );
}

function FollowUpActions({ results, onFilter }: { results: ListingSearchResults; onFilter: (q: string) => void }) {
  const filters = [
    "Filter below ₹2 Cr",
    "Only furnished",
    "Only owners",
    "Newest first",
    "Oldest first",
    "Only verified",
    "Show nearby buildings",
    "Compare prices",
    "Promote listing",
    "Find matching buyers",
  ];

  return (
    <div className="flex flex-wrap gap-1.5 mt-3">
      {filters.map((f) => (
        <button
          key={f}
          onClick={() => onFilter(f)}
          className="text-[10px] px-2.5 py-1 rounded border border-[rgba(255,255,255,0.08)] text-[#94a3b8] hover:text-white hover:border-blue-500/30 transition-colors"
        >
          {f}
        </button>
      ))}
    </div>
  );
}

export default function AIReviewPage() {
  const [tab, setTab] = useState<"chat" | "review">("chat");
  const [chatMessages, setChatMessages] = useState<{ role: string; content: string }[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [filter, setFilter] = useState("pending");
  const [loading, setLoading] = useState(true);
  const [actionId, setActionId] = useState<number | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [memory, setMemory] = useState<MemoryStats | null>(null);
  const [searchResults, setSearchResults] = useState<ListingSearchResults | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchPage, setSearchPage] = useState(0);

  useEffect(() => {
    if (typeof window !== "undefined" && new URLSearchParams(window.location.search).get("tab") === "review") {
      setTab("review");
    }
  }, []);
  const [usage, setUsage] = useState<UsageStats | null>(null);
  const [rejectModal, setRejectModal] = useState<{ id: number; fromBatch: boolean } | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [batchRejectOpen, setBatchRejectOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [sugs, c, mem, usg] = await Promise.all([
        api.getSuggestions(filter),
        api.getSuggestionCounts(),
        api.getSuggestionMemory(),
        api.getSuggestionUsage(),
      ]);
      setSuggestions(sugs);
      setCounts(c);
      setMemory(mem);
      setUsage(usg);
    } catch {
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => { load(); }, [load]);

  async function act(id: number, action: string, reason = "") {
    setActionId(id);
    try {
      await api.actOnSuggestion(id, action, reason);
      setSelected((prev) => { const next = new Set(prev); next.delete(id); return next; });
      await load();
    } catch {
    } finally {
      setActionId(null);
    }
  }

  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [chatMessages, searchResults]);

  async function sendChat() {
    if (!chatInput.trim() || chatLoading) return;
    const userMsg = chatInput.trim();
    setChatInput("");
    setChatMessages((prev) => [...prev, { role: "user", content: userMsg }]);
    setChatLoading(true);
    try {
      const key = typeof window !== "undefined" ? localStorage.getItem("doubleword_key") || "" : "";
      const model = typeof window !== "undefined" ? localStorage.getItem("doubleword_model") || "" : "";
      const res = await api.chatAIChat([...chatMessages, { role: "user", content: userMsg }], key, model);
      setChatMessages((prev) => [...prev, { role: "assistant", content: res.content }]);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown AI error";
      setChatMessages((prev) => [...prev, { role: "assistant", content: `Sorry, I couldn't process that. ${message}` }]);
    } finally {
      setChatLoading(false);
    }
  }

  function exampleQuery(q: string) {
    setChatInput(q);
  }

  async function batchAct(action: string, reason = "") {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    setActionId(-1);
    try {
      await api.batchActOnSuggestions(ids, action, reason);
      setSelected(new Set());
      await load();
    } catch {
    } finally {
      setActionId(null);
    }
  }

  function toggleSelect(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function openReject(id: number, fromBatch = false) {
    setRejectModal({ id, fromBatch });
    setRejectReason("");
  }

  function confirmReject() {
    if (!rejectModal) return;
    if (rejectModal.fromBatch) {
      batchAct("reject", rejectReason);
    } else {
      act(rejectModal.id, "reject", rejectReason);
    }
    setRejectModal(null);
    setRejectReason("");
  }

  function openBatchReject() {
    if (selected.size === 0) return;
    setBatchRejectOpen(true);
    setRejectReason("");
  }

  function confirmBatchReject() {
    batchAct("reject", rejectReason);
    setBatchRejectOpen(false);
  }

  function expandData(obj: any): string {
    if (!obj) return "—";
    if (typeof obj === "string") return obj;
    const parts: string[] = [];
    for (const [k, v] of Object.entries(obj)) {
      if (["action", "confidence_reason"].includes(k)) continue;
      if (typeof v === "string" && v.length < 60) parts.push(`${k}: ${v}`);
      else if (typeof v === "number") parts.push(`${k}: ${v}`);
    }
    return parts.join(" | ") || "—";
  }

  return (
    <div className="max-w-4xl mx-auto">
      {/* ─── Tab Bar ─── */}
      <div className="flex gap-1 mb-6 border-b border-[rgba(255,255,255,0.06)] pb-2">
        <button onClick={() => setTab("chat")}
          className={`px-3 py-1.5 rounded-lg text-xs font-medium ${tab === "chat" ? "bg-blue-600 text-white" : "text-[#94a3b8] hover:text-white"}`}
        >
          💬 AI Chat
        </button>
        <button onClick={() => setTab("review")}
          className={`px-3 py-1.5 rounded-lg text-xs font-medium ${tab === "review" ? "bg-blue-600 text-white" : "text-[#94a3b8] hover:text-white"}`}
        >
          📋 Review Center {counts.pending ? `(${counts.pending})` : ""}
        </button>
      </div>

      {/* ─── Tab: AI Chat ─── */}
      {tab === "chat" && (
        <div className="flex flex-col h-[calc(100vh-160px)]">
          <div className="flex-1 overflow-y-auto space-y-3 mb-4 pr-2">
            {chatMessages.length === 0 && !searchResults ? (
              <div className="text-center py-12">
                <div className="text-3xl mb-3">🤖</div>
                <h2 className="text-sm font-semibold text-white mb-2">Ask PropAI anything</h2>
                <p className="text-xs text-[#64748b] mb-6 max-w-md mx-auto">
                  Natural-language search across market listings, buyers, brokers, buildings, and markets.
                </p>
                <div className="flex flex-wrap gap-2 justify-center max-w-lg mx-auto">
                  {["Owner listings in Bandra under 3 Cr", "Market buyers for 3 BHK in Andheri", "Who deals in Kalina offices?", "Show all Chandak Unicorn listings", "Brokers active in Juhu rentals", "Duplicate brokers in database", "Which brokers post Chandak Unicorn most?", "Show me this week's price trends"].map((q) => (
                    <button key={q} onClick={() => exampleQuery(q)}
                      className="text-xs text-[#94a3b8] border border-[rgba(255,255,255,0.08)] hover:border-blue-500/30 hover:text-white rounded-lg px-3 py-2 transition-colors"
                    >
                      {q}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <>
                {chatMessages.map((m, i) => (
                  <div key={i} className={`flex gap-3 ${m.role === "user" ? "justify-end" : ""}`}>
                    {m.role === "assistant" && <span className="text-lg mt-1">🤖</span>}
                    <div className={`max-w-[80%] rounded-xl px-4 py-2.5 text-sm ${
                      m.role === "user"
                        ? "bg-blue-600 text-white"
                        : "bg-[#0d1117] border border-[rgba(255,255,255,0.06)] text-[#e2e8f0]"
                    }`}>
                      {m.content}
                    </div>
                    {m.role === "user" && <span className="text-lg mt-1">👤</span>}
                  </div>
                ))}

                {/* Structured Search Results */}
                {searchResults && (
                  <div className="mt-3">
                    <SearchSummary results={searchResults} />
                    {searchResults.results.length > 0 ? (
                      <div className="space-y-3">
                        {searchResults.results.map((listing) => (
                          <ListingCard key={listing.fingerprint} listing={listing} />
                        ))}
                      </div>
                    ) : (
                      <EmptyState suggestion={searchResults.suggestion} />
                    )}
                    {searchResults.results.length > 0 && (
                      <FollowUpActions results={searchResults} onFilter={(q) => setChatInput(q)} />
                    )}
                    {searchResults.has_more && (
                      <div className="mt-3 text-center">
                        <button
                          onClick={() => setSearchPage((p) => p + 1)}
                          className="text-xs px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white"
                        >
                          Load More ({searchResults.remaining} remaining)
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
            {chatLoading && (
              <div className="flex gap-3">
                <span className="text-lg mt-1">🤖</span>
                <div className="bg-[#0d1117] border border-[rgba(255,255,255,0.06)] rounded-xl px-4 py-2.5 text-sm text-[#94a3b8]">
                  Thinking...
                </div>
              </div>
            )}
            <div ref={chatEndRef} />
          </div>

          <div className="flex gap-2 items-end border-t border-[rgba(255,255,255,0.06)] pt-4">
            <textarea
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(); } }}
              placeholder="Ask a question about your market data..."
              rows={2}
              className="flex-1 bg-[#0d1117] border border-[rgba(255,255,255,0.08)] rounded-xl px-4 py-2.5 text-sm text-white placeholder-[#64748b] resize-none"
            />
            <button
              onClick={sendChat}
              disabled={chatLoading || !chatInput.trim()}
              className="px-4 py-2.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 rounded-xl text-sm font-medium"
            >
              Send
            </button>
          </div>
        </div>
      )}

      {/* ─── Tab: Review ─── */}
      {tab === "review" && (
        <>
          {/* ─── Memory + Usage Header ─── */}
          {memory && usage && (
            <div className="mb-6 grid grid-cols-2 gap-3">
              <div className="bg-[#0d1117] border border-[rgba(255,255,255,0.06)] rounded-xl p-3">
                <div className="text-[10px] font-semibold text-[#64748b] uppercase tracking-wider mb-2">AI Memory</div>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
                  <span className="text-green-400">{memory.aliases_learned} aliases</span>
                  <span className="text-blue-400">{memory.buildings_discovered} buildings</span>
                  <span className="text-yellow-400">{memory.locations_mapped} locations</span>
                  <span className="text-purple-400">{memory.broker_aliases} broker keys</span>
                  <span className="text-emerald-400">~{memory.estimated_ai_calls_avoided} AI calls avoided</span>
                </div>
              </div>
              <div className="bg-[#0d1117] border border-[rgba(255,255,255,0.06)] rounded-xl p-3">
                <div className="text-[10px] font-semibold text-[#64748b] uppercase tracking-wider mb-2">Today&apos;s AI Usage</div>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
                  <span>{usage.today_calls} calls</span>
                  <span>{formatTokens(usage.today_tokens_input)} in / {formatTokens(usage.today_tokens_output)} out</span>
                  <span className="text-amber-400">~${usage.today_cost_usd.toFixed(5)}</span>
                </div>
              </div>
            </div>
          )}

          {/* ─── Filter Tabs ─── */}
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-base font-semibold">Review Center</h2>
              <p className="text-xs text-[#94a3b8]">
                {counts.pending || 0} pending suggestion{(counts.pending || 0) !== 1 ? "s" : ""}
              </p>
            </div>
            <div className="flex gap-1 text-xs">
              {["pending", "approved", "rejected", "ignored", "all"].map((s) => (
                <button
                  key={s}
                  onClick={() => { setFilter(s); setSelected(new Set()); }}
                  className={`px-2.5 py-1.5 rounded-lg font-medium capitalize ${
                    filter === s
                      ? "bg-blue-600 text-white"
                      : "text-[#94a3b8] hover:text-white"
                  }`}
                >
                  {s} {counts[s] != null ? `(${counts[s]})` : ""}
                </button>
              ))}
            </div>
          </div>

          {/* ─── Batch Action Bar ─── */}
          {selected.size > 0 && filter === "pending" && (
            <div className="mb-4 flex items-center gap-3 bg-blue-600/10 border border-blue-500/20 rounded-xl px-4 py-2.5">
              <span className="text-xs text-blue-300 font-medium">{selected.size} selected</span>
              <button
                onClick={() => batchAct("approve")}
                disabled={actionId === -1}
                className="px-3 py-1.5 text-xs font-medium bg-green-600 hover:bg-green-500 disabled:opacity-40 rounded-lg"
              >
                {actionId === -1 ? "..." : "Approve Selected"}
              </button>
              <button
                onClick={openBatchReject}
                disabled={actionId === -1}
                className="px-3 py-1.5 text-xs font-medium bg-red-600/60 hover:bg-red-500 disabled:opacity-40 rounded-lg"
              >
                Reject Selected
              </button>
              <button
                onClick={() => batchAct("ignore")}
                disabled={actionId === -1}
                className="px-3 py-1.5 text-xs font-medium text-[#64748b] hover:text-white border border-[rgba(255,255,255,0.1)] rounded-lg"
              >
                Ignore Selected
              </button>
              <button
                onClick={() => setSelected(new Set())}
                className="px-3 py-1.5 text-xs font-medium text-[#64748b] hover:text-white ml-auto"
              >
                Clear
              </button>
            </div>
          )}

          {/* ─── Rejection Reason Modal (single) ─── */}
          {rejectModal && !rejectModal.fromBatch && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setRejectModal(null)}>
              <div className="bg-[#0d1117] border border-[rgba(255,255,255,0.08)] rounded-xl p-5 w-96" onClick={(e) => e.stopPropagation()}>
                <h3 className="text-sm font-semibold mb-3">Reject Suggestion #{rejectModal.id}</h3>
                <p className="text-xs text-[#94a3b8] mb-3">Why are you rejecting this suggestion? (optional)</p>
                <div className="flex flex-wrap gap-2 mb-3">
                  {["Temporary / project name", "Not a real building", "Duplicate of existing", "Wrong locality", "Incorrect price", "Not useful"].map((r) => (
                    <button key={r} onClick={() => setRejectReason(r)}
                      className={`text-xs px-2.5 py-1 rounded-lg border ${rejectReason === r ? "bg-red-500/20 border-red-500/40 text-red-300" : "border-[rgba(255,255,255,0.08)] text-[#94a3b8] hover:text-white"}`}
                    >{r}</button>
                  ))}
                </div>
                <textarea
                  value={rejectReason}
                  onChange={(e) => setRejectReason(e.target.value)}
                  placeholder="Or type a custom reason..."
                  className="w-full bg-[#161b22] border border-[rgba(255,255,255,0.08)] rounded-lg p-2 text-xs text-white placeholder-[#64748b] resize-none h-16 mb-3"
                />
                <div className="flex justify-end gap-2">
                  <button onClick={() => setRejectModal(null)} className="px-3 py-1.5 text-xs font-medium text-[#94a3b8] border border-[rgba(255,255,255,0.1)] rounded-lg">Cancel</button>
                  <button onClick={confirmReject} className="px-3 py-1.5 text-xs font-medium bg-red-600 hover:bg-red-500 rounded-lg">Reject</button>
                </div>
              </div>
            </div>
          )}

          {/* ─── Batch Reject Modal ─── */}
          {batchRejectOpen && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setBatchRejectOpen(false)}>
              <div className="bg-[#0d1117] border border-[rgba(255,255,255,0.08)] rounded-xl p-5 w-96" onClick={(e) => e.stopPropagation()}>
                <h3 className="text-sm font-semibold mb-3">Reject {selected.size} Suggestions</h3>
                <p className="text-xs text-[#94a3b8] mb-3">Why are you rejecting these suggestions? (optional — all get same reason)</p>
                <div className="flex flex-wrap gap-2 mb-3">
                  {["Temporary / project name", "Not a real building", "Duplicate of existing", "Wrong locality", "Incorrect price", "Not useful"].map((r) => (
                    <button key={r} onClick={() => setRejectReason(r)}
                      className={`text-xs px-2.5 py-1 rounded-lg border ${rejectReason === r ? "bg-red-500/20 border-red-500/40 text-red-300" : "border-[rgba(255,255,255,0.08)] text-[#94a3b8] hover:text-white"}`}
                    >{r}</button>
                  ))}
                </div>
                <textarea
                  value={rejectReason}
                  onChange={(e) => setRejectReason(e.target.value)}
                  placeholder="Or type a custom reason..."
                  className="w-full bg-[#161b22] border border-[rgba(255,255,255,0.08)] rounded-lg p-2 text-xs text-white placeholder-[#64748b] resize-none h-16 mb-3"
                />
                <div className="flex justify-end gap-2">
                  <button onClick={() => setBatchRejectOpen(false)} className="px-3 py-1.5 text-xs font-medium text-[#94a3b8] border border-[rgba(255,255,255,0.1)] rounded-lg">Cancel</button>
                  <button onClick={confirmBatchReject} className="px-3 py-1.5 text-xs font-medium bg-red-600 hover:bg-red-500 rounded-lg">Reject All</button>
                </div>
              </div>
            </div>
          )}

          {/* ─── Review Cards ─── */}
          {loading ? (
            <div className="text-center text-[#64748b] py-16">Loading...</div>
          ) : suggestions.length === 0 ? (
            <div className="text-center text-[#64748b] py-16">
              No {filter === "all" ? "" : filter} suggestions
            </div>
          ) : (
            <div className="space-y-3">
              {suggestions.map((s) => {
                const isDeterministic = DETERMINISTIC_AGENTS.has(s.agent);
                const evidence = evidenceLines(s);
                const impact = impactLines(s);
                const isSelected = selected.has(s.id);

                return (
                  <div
                    key={s.id}
                    className={`bg-[#0d1117] border rounded-xl p-4 transition-all ${
                      isSelected
                        ? "border-blue-500/40 ring-1 ring-blue-500/20"
                        : "border-[rgba(255,255,255,0.06)]"
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      {/* Checkbox */}
                      {s.status === "pending" && (
                        <label className="flex items-center mt-1 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => toggleSelect(s.id)}
                            className="w-4 h-4 rounded border-[rgba(255,255,255,0.2)] bg-transparent accent-blue-500"
                          />
                        </label>
                      )}

                      {/* Icon */}
                      <span className="text-lg mt-0.5">
                        {AGENT_ICONS[s.agent] || "🤖"}
                      </span>

                      {/* Content */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1 flex-wrap">
                          {/* Agent label */}
                          <span className="text-xs font-medium text-blue-400 bg-blue-500/10 px-2 py-0.5 rounded">
                            {AGENT_LABELS[s.agent] || s.agent}
                          </span>

                          {/* Deterministic / AI badge */}
                          <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${
                            isDeterministic
                              ? "text-emerald-400 bg-emerald-500/10"
                              : "text-violet-400 bg-violet-500/10"
                          }`}>
                            {isDeterministic ? "AUTOMATIC" : "AI"}
                          </span>

                          {/* Confidence */}
                          {s.confidence > 0 && (
                            <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${
                              s.confidence >= 0.8
                                ? "text-green-400 bg-green-500/10"
                                : s.confidence >= 0.5
                                  ? "text-yellow-400 bg-yellow-500/10"
                                  : "text-red-400 bg-red-500/10"
                            }`}>
                              {Math.round(s.confidence * 100)}%
                            </span>
                          )}

                          {/* Timestamp */}
                          <span className="text-[10px] text-[#64748b] ml-auto">
                            {new Date(s.created_at).toLocaleString("en-IN", {
                              day: "numeric",
                              month: "short",
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </span>
                        </div>

                        {/* Title */}
                        <h3 className="text-sm font-semibold mb-0.5">{s.title}</h3>

                        {/* Description */}
                        {s.description && (
                          <p className="text-xs text-[#94a3b8] whitespace-pre-wrap mb-2">{s.description}</p>
                        )}

                        {/* Evidence */}
                        {evidence.length > 0 && (
                          <div className="mb-2">
                            {evidence.map((line, i) => (
                              <div key={i} className="text-[11px] text-green-400/80 leading-5">{line}</div>
                            ))}
                          </div>
                        )}

                        {/* Impact */}
                        {impact.length > 0 && s.status === "pending" && (
                          <div className="mb-1">
                            <span className="text-[10px] font-semibold text-[#64748b] uppercase tracking-wider mr-2">Impact</span>
                            {impact.map((line, i) => (
                              <div key={i} className="text-[11px] text-blue-400/70 leading-5">{line}</div>
                            ))}
                          </div>
                        )}

                        {/* Source data detail for non-pending */}
                        {s.status !== "pending" && s.source_data && (
                          <details className="mt-1">
                            <summary className="text-[10px] text-[#64748b] cursor-pointer hover:text-white">Raw data</summary>
                            <pre className="text-[10px] text-[#64748b] mt-1 bg-[#161b22] p-2 rounded overflow-x-auto">{JSON.stringify(s.source_data, null, 1)}</pre>
                          </details>
                        )}
                      </div>
                    </div>

                    {/* Pending actions */}
                    {s.status === "pending" && (
                      <div className="flex gap-2 mt-3 ml-10">
                        <button
                          onClick={() => act(s.id, "approve")}
                          disabled={actionId === s.id}
                          className="px-3 py-1.5 text-xs font-medium bg-green-600 hover:bg-green-500 disabled:opacity-40 rounded-lg"
                        >
                          {actionId === s.id ? "..." : "Approve"}
                        </button>
                        <button
                          onClick={() => openReject(s.id)}
                          disabled={actionId === s.id}
                          className="px-3 py-1.5 text-xs font-medium bg-red-600/60 hover:bg-red-500 disabled:opacity-40 rounded-lg"
                        >
                          Reject
                        </button>
                        <button
                          onClick={() => act(s.id, "ignore")}
                          disabled={actionId === s.id}
                          className="px-3 py-1.5 text-xs font-medium text-[#64748b] hover:text-white border border-[rgba(255,255,255,0.1)] rounded-lg"
                        >
                          Ignore
                        </button>
                      </div>
                    )}

                    {/* Status badge */}
                    {s.status !== "pending" && (
                      <div className="mt-3 ml-10 flex items-center gap-2">
                        <span className={`text-xs font-medium px-2 py-0.5 rounded ${
                          s.status === "approved"
                            ? "text-green-400 bg-green-500/10"
                            : s.status === "rejected"
                              ? "text-red-400 bg-red-500/10"
                              : "text-[#64748b] bg-[rgba(255,255,255,0.04)]"
                        }`}>
                          {s.status.charAt(0).toUpperCase() + s.status.slice(1)}
                        </span>
                        {s.rejection_reason && (
                          <span className="text-[11px] text-[#94a3b8]">
                            — {s.rejection_reason}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}