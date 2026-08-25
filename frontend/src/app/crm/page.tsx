"use client";

import { useEffect, useRef, useState } from "react";
import { Building2, CalendarDays, MapPin, MessageCircle, Ruler, Search, ShieldCheck, Trash2, Upload } from "lucide-react";
import { CrmInventoryItem, deleteCrmInventory, getCrmInventory, importCrmInventory } from "@/lib/api";

export const dynamic = "force-dynamic";

export default function PrivateCrmPage() {
  const [rows, setRows] = useState<CrmInventoryItem[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function load() {
    setLoading(true);
    try { setRows(await getCrmInventory(query)); setError(null); }
    catch { setError("Private inventory could not be loaded."); }
    finally { setLoading(false); }
  }

  useEffect(() => { void load(); }, [query]);

  async function onImport(file?: File) {
    if (!file) return;
    setBusy(true); setMessage(null); setError(null);
    try {
      const result = await importCrmInventory(file);
      setMessage(`${result.imported} private inventory records imported${result.rejected.length ? `; ${result.rejected.length} rows skipped` : ""}.`);
      await load();
    } catch { setError("That CSV could not be imported. Check the header row and try again."); }
    finally { setBusy(false); if (inputRef.current) inputRef.current.value = ""; }
  }

  async function remove(id: number, label: string) {
    if (!window.confirm(`Remove ${label || "this private record"}?`)) return;
    try { await deleteCrmInventory(id); setRows(current => current.filter(row => row.id !== id)); }
    catch { setError("The record could not be removed."); }
  }

  return (
    <main className="min-h-screen bg-[var(--bg-base)] text-[var(--text-primary)]">
      <div className="mx-auto max-w-6xl px-5 py-10 lg:px-8">
        <header className="flex flex-col gap-6 border-b border-[var(--border-subtle)] pb-7 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.22em] text-[var(--accent-primary)]">Workspace operations</p>
            <h1 className="text-3xl font-semibold tracking-tight">Private CRM</h1>
            <p className="mt-2 max-w-2xl text-sm text-[var(--text-secondary)]">Chat is the primary intake. Send broker-owned inventory to PropAI Assistant, confirm the save, and find it here whenever you need it.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <a href="/chat" className="inline-flex items-center gap-2 rounded-lg bg-[var(--signal-dim)] px-4 py-2.5 text-sm font-semibold text-[var(--parchment)] transition hover:bg-[var(--signal)]"><MessageCircle size={16} />Add via chat</a>
            <input ref={inputRef} type="file" accept=".csv,text/csv" className="hidden" onChange={event => void onImport(event.target.files?.[0])} />
            <button onClick={() => inputRef.current?.click()} disabled={busy} className="inline-flex items-center gap-2 rounded-lg border border-[var(--border-strong)] px-4 py-2.5 text-sm font-semibold transition hover:bg-[var(--bg-surface-hover)] disabled:opacity-60"><Upload size={16} />{busy ? "Importing…" : "Import CSV"}</button>
          </div>
        </header>

        <section className="mt-6 flex items-start gap-3 rounded-xl border border-[var(--signal-dim)]/35 bg-[var(--surface-raised)] p-4 text-sm">
          <ShieldCheck size={18} className="mt-0.5 shrink-0 text-[var(--signal-dim)]" />
          <p><strong>Private by default.</strong> Chat capture requires your confirmation. These records are excluded from Market Inbox, marketplace search, and Auto Match unless you explicitly publish them.</p>
        </section>

        <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <label className="relative block max-w-md flex-1"><Search size={16} className="absolute left-3 top-3 text-[var(--text-secondary)]" /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search building, locality, contact…" className="w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-raised)] py-2.5 pl-9 pr-3 text-sm outline-none focus:border-[var(--accent-primary)]" /></label>
          <div className="flex items-center gap-2 text-xs text-[var(--text-secondary)]"><ShieldCheck size={15} className="text-[var(--accent-primary)]" />{rows.length} records in this workspace</div>
        </div>

        {message && <p className="mt-5 rounded-lg border border-[var(--signal)]/30 bg-[var(--signal)]/10 px-4 py-3 text-sm">{message}</p>}
        {error && <p className="mt-5 rounded-lg border border-[var(--amber)]/40 bg-[var(--amber)]/10 px-4 py-3 text-sm">{error}</p>}

        {loading ? <div className="mt-10 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-raised)] p-8 text-sm text-[var(--text-secondary)]">Loading private inventory…</div> : rows.length === 0 ? (
          <div className="mt-10 rounded-xl border border-dashed border-[var(--border-strong)] bg-[var(--surface-raised)] p-12 text-center"><MessageCircle className="mx-auto mb-4 text-[var(--accent-primary)]" size={28} /><h2 className="text-lg font-semibold">No private inventory yet</h2><p className="mx-auto mt-2 max-w-md text-sm text-[var(--text-secondary)]">Open the assistant and paste a broker message in plain language. PropAI will prepare a private record and ask you to confirm before saving.</p><a href="/chat" className="mt-5 inline-flex items-center gap-2 rounded-lg bg-[var(--signal-dim)] px-4 py-2.5 text-sm font-semibold text-[var(--parchment)] hover:bg-[var(--signal)]"><MessageCircle size={16} />Open chat</a></div>
        ) : <div className="mt-7 grid gap-4 md:grid-cols-2">{rows.map(row => <article key={row.id} className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-raised)] p-5 shadow-[0_4px_18px_rgba(54,48,36,0.04)]"><div className="flex items-start justify-between gap-4"><div><p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--accent-primary)]">Private inventory</p><h2 className="mt-1 text-lg font-semibold">{row.building_name || "Unnamed property"}</h2></div><button aria-label={`Delete ${row.building_name || "record"}`} onClick={() => void remove(row.id, row.building_name || "this record")} className="rounded-md p-2 text-[var(--text-secondary)] hover:bg-[var(--bg-surface-hover)] hover:text-red-700"><Trash2 size={16} /></button></div><div className="mt-4 grid grid-cols-2 gap-3 text-sm text-[var(--text-secondary)]"><span className="flex gap-2"><MapPin size={15} />{row.location || "Locality not specified"}</span><span className="flex gap-2"><Building2 size={15} />{row.bhk || "Configuration not specified"}</span><span className="flex gap-2"><Ruler size={15} />{row.area_sqft ? `${row.area_sqft} sq ft` : "Area not specified"}</span><span className="flex gap-2"><CalendarDays size={15} />{row.availability || "Availability not specified"}</span></div><div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-[var(--border-subtle)] pt-4"><span className="font-semibold text-[var(--amber)]">{row.quote || "Quote not specified"}</span><span className="text-xs text-[var(--text-secondary)]">Private · not shared</span></div></article>)}</div>}
      </div>
    </main>
  );
}
