"use client";

import { useEffect, useState } from "react";

interface TrainerTerm {
  id: number;
  term: string;
  context: string;
  frequency: number;
  first_seen: string;
  last_seen: string;
  status: string;
  resolved_by: string | null;
  resolved_at: string | null;
  raw_message_id: number | null;
  raw_message: string;
  notes: string;
}

interface TrainerStats {
  total: number;
  pending: number;
  resolved: number;
  ignored: number;
  building: number;
  society: number;
  landmark: number;
  locality: number;
  combined_locality: number;
  other: number;
}

const KNOWLEDGE_OPTIONS = [
  { value: "building", label: "Building", color: "blue", desc: "This is a building/apartment name" },
  { value: "society", label: "Society", color: "purple", desc: "This is a housing society/CHS" },
  { value: "landmark", label: "Landmark", color: "amber", desc: "This is a known area/landmark" },
  { value: "locality", label: "Locality", color: "teal", desc: "This is a micro-market name" },
  { value: "combined_locality", label: "Combined Localities", color: "emerald", desc: "Maps to multiple canonical localities (e.g. Santacruz East & West)" },
  { value: "other", label: "Other", color: "slate", desc: "Tag for future reference" },
];

function highlightTerm(text: string, term: string): { before: string; match: string; after: string } {
  const idx = text.toLowerCase().indexOf(term.toLowerCase());
  if (idx === -1) {
    return { before: "", match: "", after: text };
  }
  const before = text.slice(0, idx);
  const match = text.slice(idx, idx + term.length);
  const after = text.slice(idx + term.length);
  return { before, match, after };
}

const NOISE_PATTERNS = [
  /\b(brand new|newly built|ready to move|immediate possession|under construction)\b/i,
  /\b(easy|direct|individual|exclusive|premium|luxury|affordable|budget)\s+(access|entry|inventory|deal|owner|property)\b/i,
  /\b(sea view|city view|garden view|open view|natural light|vastu)\b/i,
  /\b(semi furnished|fully furnished|unfurnished|newly painted|renovated)\b/i,
  /\b(prime location|premium location|peaceful|quiet|serene|spacious|compact)\b/i,
  /\b(negotiable|nearest|opposite|behind|beside|near|close to|walking distance)\b/i,
  /\b(must see|must visit|owner|deal direct|rare find|great deal)\b/i,
];

function isParserNoise(term: string, message: string): boolean {
  const lower = term.toLowerCase();
  const noiseWords = ["individual", "brand", "new", "easy", "direct", "newly", "ready",
    "premium", "luxury", "affordable", "budget", "prime", "spacious", "compact",
    "renovated", "semi", "fully", "unfurnished", "vastu", "natural", "must",
    "rare", "exclusive", "owner", "deal", "near", "opposite", "behind", "beside",
    "walking", "quiet", "serene", "peaceful", "immediate"];
  const words = lower.split(/\s+/);
  if (words.every(w => noiseWords.includes(w))) return true;
  if (NOISE_PATTERNS.some(p => p.test(lower))) return true;
  return NOISE_PATTERNS.some(p => p.test(message));
}

export default function TrainerPage() {
  const [terms, setTerms] = useState<TrainerTerm[]>([]);
  const [stats, setStats] = useState<TrainerStats | null>(null);
  const [filter, setFilter] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [resolving, setResolving] = useState<Set<number>>(new Set());
  const [incoming, setIncoming] = useState<{ term: string; status: string; message_id?: string; result?: string } | null>(null);

  const load = async () => {
    setLoading(true);
    const [termsRes, statsRes] = await Promise.all([
      fetch(`/api/trainer/terms${filter ? `?status=${filter}` : ""}`).then(r => r.json()),
      fetch("/api/trainer/stats").then(r => r.json()),
    ]);
    setTerms(termsRes);
    setStats(statsRes);
    setLoading(false);
  };

  useEffect(() => { load(); }, [filter]);

  // Handle incoming query params: ?term=...&type=...&message=...
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const term = params.get("term");
    const type = params.get("type");
    const message = params.get("message");
    if (term && type) {
      setIncoming({ term, status: type, message_id: message || undefined });
      (async () => {
        try {
          const res = await fetch("/api/trainer/inline-resolve", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              text: term,
              status: type,
              raw_message_id: message ? parseInt(message) : null,
            }),
          });
          const data = await res.json();
          setIncoming(prev => prev ? { ...prev, result: data.status === "ok" ? "added" : "error" } : null);
          load();
          // Clean URL
          window.history.replaceState({}, "", "/trainer");
        } catch {
          setIncoming(prev => prev ? { ...prev, result: "error" } : null);
        }
      })();
    }
  }, []);

  const resolve = async (id: number, status: string, notes: string = "") => {
    setResolving(prev => new Set(prev).add(id));
    await fetch("/api/trainer/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ term_id: id, status, notes }),
    });
    setResolving(prev => { const next = new Set(prev); next.delete(id); return next; });
    load();
  };

  const batchResolve = async (status: string) => {
    if (selected.size === 0) return;
    await fetch("/api/trainer/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: Array.from(selected).map(id => ({ term_id: id, status })) }),
    });
    setSelected(new Set());
    load();
  };

  const scan = async () => {
    setScanning(true);
    await fetch("/api/trainer/scan", { method: "POST" });
    setScanning(false);
    load();
  };

  const toggleSelect = (id: number) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const pendingTerms = terms.filter(t => t.status === "pending");
  const needsKnowledge = pendingTerms.filter(t => !isParserNoise(t.term, t.raw_message || t.context));
  const parserNoise = pendingTerms.filter(t => isParserNoise(t.term, t.raw_message || t.context));
  const resolvedTerms = terms.filter(t => t.status !== "pending" && t.status !== "ignored");
  const [tab, setTab] = useState<"knowledge" | "noise" | "resolved">("knowledge");

  return (
    <div className="max-w-5xl">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-[#e2e8f0]">Knowledge Trainer</h1>
          <p className="text-sm text-[#64748b] mt-1">
            Teach PropAI about unknown terms found in WhatsApp messages.
          </p>
        </div>
        <button
          onClick={scan}
          disabled={scanning}
          className="px-4 py-2 bg-[#3b82f6] text-white rounded-lg hover:bg-blue-600 disabled:opacity-50 text-sm font-medium transition-colors"
        >
          {scanning ? "Scanning..." : "Scan Messages"}
        </button>
      </div>

      {/* Incoming term notification */}
      {incoming && (
        <div className={`rounded-lg p-4 mb-4 text-sm ${
          incoming.result === "added"
            ? "bg-green-500/10 border border-green-500/20 text-green-200"
            : incoming.result === "error"
            ? "bg-red-500/10 border border-red-500/20 text-red-200"
            : "bg-blue-500/10 border border-blue-500/20 text-blue-200"
        }`}>
          {!incoming.result ? (
            <>Adding <strong>{incoming.term}</strong> as {incoming.status}...</>
          ) : incoming.result === "added" ? (
            <>✅ <strong>{incoming.term}</strong> classified as <strong>{incoming.status}</strong></>
          ) : (
            <>❌ Failed to add <strong>{incoming.term}</strong></>
          )}
        </div>
      )}

      {/* Stats */}
      {stats && (
        <div className="grid grid-cols-8 gap-3 mb-6">
          {[
            { label: "Total", value: stats.total, bg: "bg-[rgba(255,255,255,0.04)]", text: "text-[#94a3b8]" },
            { label: "Pending", value: stats.pending, bg: "bg-amber-500/10", text: "text-amber-300" },
            { label: "Buildings", value: stats.building || 0, bg: "bg-blue-500/10", text: "text-blue-300" },
            { label: "Societies", value: stats.society || 0, bg: "bg-purple-500/10", text: "text-purple-300" },
            { label: "Landmarks", value: stats.landmark || 0, bg: "bg-teal-500/10", text: "text-teal-300" },
            { label: "Localities", value: stats.locality || 0, bg: "bg-emerald-500/10", text: "text-emerald-300" },
            { label: "Combined", value: stats.combined_locality || 0, bg: "bg-emerald-500/10", text: "text-emerald-300" },
            { label: "Ignored", value: stats.ignored || 0, bg: "bg-[rgba(255,255,255,0.03)]", text: "text-[#4a5568]" },
          ].map(s => (
            <div key={s.label} className={`rounded-lg p-3 ${s.bg}`}>
              <div className={`text-2xl font-bold ${s.text}`}>{s.value}</div>
              <div className={`text-xs opacity-75 ${s.text}`}>{s.label}</div>
            </div>
          ))}
        </div>
      )}

      {/* Help Banner */}
      {pendingTerms.length > 0 && tab !== "resolved" && (
        <div className="bg-blue-500/10 border border-blue-500/20 rounded-lg p-4 mb-4 text-sm text-blue-200">
          <strong>How this works:</strong> PropAI found terms in messages that don't match known buildings, landmarks, or localities.
          Classify them below to teach PropAI. Terms marked <strong>Building</strong>, <strong>Society</strong>, <strong>Landmark</strong>, <strong>Locality</strong>, or <strong>Combined Localities</strong>
          {" "}will be saved to the knowledge base and future parses will recognize them.
        </div>
      )}

      {/* Batch Actions */}
      {selected.size > 0 && tab !== "resolved" && (
        <div className="bg-blue-500/10 border border-blue-500/20 rounded-lg p-3 mb-4 flex items-center justify-between">
          <span className="text-sm text-blue-200">{selected.size} selected</span>
          <div className="flex gap-2">
            {KNOWLEDGE_OPTIONS.map(s => (
              <button
                key={s.value}
                onClick={() => batchResolve(s.value)}
                className={`px-3 py-1 rounded text-xs text-white bg-${s.color}-500 hover:bg-${s.color}-600 transition-colors`}
              >
                → {s.label}
              </button>
            ))}
            <button
              onClick={() => batchResolve("ignored")}
              className="px-3 py-1 rounded text-xs bg-[rgba(255,255,255,0.06)] text-[#64748b] hover:bg-[rgba(255,255,255,0.10)] transition-colors"
            >
              Ignore All
            </button>
          </div>
        </div>
      )}

      {/* Filter bar */}
      <div className="flex gap-2 mb-4 flex-wrap">
        {[null, "pending", "building", "society", "landmark", "locality", "combined_locality", "other", "ignored"].map(f => (
          <button
            key={f || "all"}
            onClick={() => setFilter(f)}
            className={`px-3 py-1.5 rounded-lg text-sm transition-colors ${
              filter === f
                ? "bg-[#3b82f6] text-white"
                : "bg-[rgba(255,255,255,0.04)] text-[#94a3b8] hover:bg-[rgba(255,255,255,0.08)] hover:text-[#e2e8f0]"
            }`}
          >
            {f || "All"}
          </button>
        ))}
      </div>

      {/* Tab navigation */}
      <div className="flex gap-1 mb-4 border-b border-[rgba(255,255,255,0.06)]">
        {[
          { id: "knowledge" as const, label: "Needs Knowledge", count: needsKnowledge.length, color: "text-blue-400" },
          { id: "noise" as const, label: "Parser Noise", count: parserNoise.length, color: "text-[#64748b]" },
          { id: "resolved" as const, label: "Resolved", count: resolvedTerms.length, color: "text-[#64748b]" },
        ].map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-4 py-2 text-sm font-medium transition-colors relative ${
              tab === t.id
                ? "text-[#e2e8f0]"
                : "text-[#64748b] hover:text-[#94a3b8]"
            }`}
          >
            {t.label}
            <span className={`ml-1.5 text-xs ${tab === t.id ? t.color : "text-[#4a5568]"}`}>({t.count})</span>
            {tab === t.id && (
              <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-[#3b82f6] rounded-full" />
            )}
          </button>
        ))}
      </div>

      {/* Content */}
      {loading ? (
        <div className="text-center py-12 text-[#64748b]">Loading...</div>
      ) : terms.length === 0 ? (
        <div className="text-center py-12">
          <div className="text-4xl mb-3">🎯</div>
          <h3 className="text-lg font-medium text-[#e2e8f0] mb-1">No terms found</h3>
          <p className="text-sm text-[#64748b]">
            Click <strong>"Scan Messages"</strong> to find unknown terms for training.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {/* Tab: Needs Knowledge */}
          {tab === "knowledge" && needsKnowledge.length > 0 && (
            <div className="mb-6">
              {needsKnowledge.map(term => (
                <TermCard
                  key={term.id}
                  term={term}
                  selected={selected.has(term.id)}
                  onToggle={() => toggleSelect(term.id)}
                  onResolve={(s, notes) => resolve(term.id, s, notes)}
                  resolving={resolving.has(term.id)}
                />
              ))}
            </div>
          )}

          {/* Tab: Parser Noise */}
          {tab === "noise" && parserNoise.length > 0 && (
            <div className="mb-6">
              {parserNoise.map(term => (
                <TermCard
                  key={term.id}
                  term={term}
                  selected={selected.has(term.id)}
                  onToggle={() => toggleSelect(term.id)}
                  onResolve={(s, notes) => resolve(term.id, s, notes)}
                  resolving={resolving.has(term.id)}
                  isNoise
                />
              ))}
            </div>
          )}

          {/* Tab: Resolved */}
          {tab === "resolved" && resolvedTerms.length > 0 && (
            <div>
              <h3 className="text-sm font-medium text-[#64748b] mb-2">Resolved ({resolvedTerms.length})</h3>
              {resolvedTerms.map(term => (
                <div key={term.id} className="bg-[#0d1117] border border-[rgba(255,255,255,0.04)] rounded-lg p-3 mb-1.5 opacity-60">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <span className="font-medium text-[#94a3b8]">{term.term}</span>
                      <span className={`text-xs px-2 py-0.5 rounded ${
                        term.status === "building" ? "bg-blue-500/10 text-blue-300" :
                        term.status === "society" ? "bg-purple-500/10 text-purple-300" :
                        term.status === "landmark" ? "bg-teal-500/10 text-teal-300" :
                        term.status === "locality" ? "bg-emerald-500/10 text-emerald-300" :
                        term.status === "combined_locality" ? "bg-emerald-500/10 text-emerald-300" :
                        term.status === "other" ? "bg-[rgba(255,255,255,0.04)] text-[#94a3b8]" :
                        "bg-[rgba(255,255,255,0.03)] text-[#4a5568]"
                      }`}>
                        {term.status}
                      </span>
                      <span className="text-xs text-[#4a5568]">{term.frequency}x</span>
                      {term.notes && (
                        <span className="text-xs text-[#4a5568] italic">— {term.notes}</span>
                      )}
                    </div>
                    <span className="text-xs text-[#4a5568]">
                      {term.resolved_at ? new Date(term.resolved_at).toLocaleDateString() : ""}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TermCard({
  term, selected, onToggle, onResolve, resolving, isNoise,
}: {
  term: TrainerTerm;
  selected: boolean;
  onToggle: () => void;
  onResolve: (status: string, notes?: string) => void;
  resolving: boolean;
  isNoise?: boolean;
}) {
  const [notes, setNotes] = useState("");
  const message = term.raw_message || term.context;
  const highlight = highlightTerm(message, term.term);

  return (
    <div className={`bg-[#0d1117] border rounded-lg p-4 mb-2 transition-colors ${
      isNoise
        ? "border-dashed border-[rgba(255,255,255,0.06)] hover:border-[rgba(255,255,255,0.10)]"
        : "border-[rgba(255,255,255,0.06)] hover:border-[rgba(255,255,255,0.12)]"
    }`}>
      <div className="flex items-start gap-3">
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggle}
          className="w-4 h-4 mt-1 shrink-0 accent-blue-500"
        />
        <div className="flex-1 min-w-0">
          {/* Term name + frequency badge */}
          <div className="flex items-center gap-2 mb-1.5">
            <span className="font-semibold text-[#e2e8f0] text-base">{term.term}</span>
            <span className="text-xs bg-[rgba(255,255,255,0.04)] text-[#64748b] px-2 py-0.5 rounded-full">
              {term.frequency}x
            </span>
            {isNoise && (
              <span className="text-xs bg-[rgba(255,255,255,0.03)] text-[#4a5568] px-2 py-0.5 rounded-full">
                Likely noise
              </span>
            )}
          </div>

          {/* Original message with highlighted term */}
          {message && (
            <div className="text-xs text-[#94a3b8] bg-[#090d12] rounded p-2 mb-2 font-mono leading-relaxed border border-[rgba(255,255,255,0.04)]">
              <span className="text-[#4a5568]">&ldquo;</span>
              {highlight.before}
              <span className="bg-yellow-500/20 text-yellow-200 font-semibold px-0.5 rounded">{highlight.match}</span>
              {highlight.after}
              <span className="text-[#4a5568]">&rdquo;</span>
            </div>
          )}

          {/* Question prompt */}
          <div className="text-xs text-[#4a5568] mb-2">
            {isNoise
              ? "This looks like marketing text or a description. Should the parser skip it?"
              : `Is "${term.term}" a building name, society, landmark, or locality?`}
          </div>

          {/* Notes input */}
          <div className="mb-2">
            <input
              type="text"
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="What is this? (e.g. tenant name, marketing phrase, area name...)"
              className="w-full text-xs bg-[#090d12] border border-[rgba(255,255,255,0.08)] rounded px-2.5 py-1.5 text-[#94a3b8] placeholder-[#4a5568] outline-none focus:border-blue-500/40 transition-colors"
            />
          </div>

          {/* Action buttons */}
          <div className="flex flex-wrap gap-1.5">
            {KNOWLEDGE_OPTIONS.filter(o => !isNoise || o.value === "other").map(s => {
              const btnColors: Record<string, string> = {
                blue: "bg-blue-500 hover:bg-blue-600",
                purple: "bg-purple-500 hover:bg-purple-600",
                amber: "bg-amber-500 hover:bg-amber-600",
                teal: "bg-teal-500 hover:bg-teal-600",
                emerald: "bg-emerald-500 hover:bg-emerald-600",
                slate: "bg-slate-500 hover:bg-slate-600",
              };
              return (
                <button
                  key={s.value}
                  onClick={() => onResolve(s.value, notes)}
                  disabled={resolving}
                  className={`px-2.5 py-1 rounded text-xs text-white ${btnColors[s.color] || btnColors.blue} disabled:opacity-50 transition-colors`}
                  title={s.desc}
                >
                  {s.label}
                </button>
              );
            })}
            <button
              onClick={() => onResolve("ignored", notes)}
              disabled={resolving}
              className="px-2.5 py-1 rounded text-xs bg-[rgba(255,255,255,0.06)] text-[#64748b] hover:bg-[rgba(255,255,255,0.10)] disabled:opacity-50 transition-colors"
              title={isNoise ? "Confirm this is noise — parser will skip it" : "Not an entity — ignore this term"}
            >
              ✕ Ignore
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
