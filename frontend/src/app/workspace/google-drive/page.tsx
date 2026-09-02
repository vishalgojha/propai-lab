"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { Check, HardDrive, RefreshCw } from "lucide-react";
import { fetchJSON } from "@/lib/api";

type DriveStatus = { connected: boolean; connection?: { google_email?: string } | null; exports?: Array<{ id: number; file_name: string; last_row_count: number; last_success_at?: string | null; last_error?: string | null }> };
type Inventory = { id: number; building_name?: string; location?: string; bhk?: string; quote?: string };

export default function GoogleDrivePage() {
  const params = useSearchParams();
  const driveResult = params.get("drive");
  const [status, setStatus] = useState<DriveStatus | null>(null);
  const [inventory, setInventory] = useState<Inventory[]>([]);
  const [selected, setSelected] = useState<number[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      const [drive, rows] = await Promise.all([
        fetchJSON<DriveStatus>("/google-drive"),
        fetchJSON<Inventory[]>("/crm/inventory?limit=500"),
      ]);
      setStatus(drive);
      setInventory(rows || []);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not load Google Drive settings");
    } finally { setLoading(false); }
  }

  useEffect(() => { void load(); }, []);

  useEffect(() => {
    if (driveResult === "connected") setMessage("Google Drive connected. Select private CRM inventory below, or select Market Inbox listings to export from the Market Inbox.");
    if (driveResult === "cancelled") setMessage("Google Drive connection was cancelled.");
    if (driveResult === "failed") setMessage("Google Drive connection failed. Check the OAuth configuration and try again.");
  }, [driveResult]);

  async function connect() {
    setBusy(true);
    try {
      const result = await fetchJSON<{ authorization_url: string }>("/google-drive/connect");
      window.location.assign(result.authorization_url);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not start Google connection");
      setBusy(false);
    }
  }

  async function createExport() {
    if (!selected.length) return;
    setBusy(true);
    setMessage(null);
    try {
      await fetchJSON("/google-drive/exports", { method: "POST", body: JSON.stringify({ inventory_ids: selected }) });
      setMessage("Export queued. The Google Sheet will update shortly.");
      await load();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not create export"); }
    finally { setBusy(false); }
  }

  return (
    <section className="mx-auto max-w-4xl px-4 pb-12 pt-8 lg:px-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="mb-2 flex items-center gap-2 text-xs uppercase tracking-[0.16em] text-cyan-300"><HardDrive className="h-4 w-4" /> Integration</div>
          <h2 className="text-2xl font-semibold text-white">Google Drive</h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-zinc-400">Keep selected CRM or Market Inbox inventory available in a Google Sheet. PropAI only writes the records you choose.</p>
        </div>
        <button type="button" onClick={() => void load()} disabled={loading} className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-white/10 px-3 text-xs text-zinc-300 hover:bg-white/5 disabled:opacity-50"><RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} /> Refresh</button>
      </div>
      <div className="mt-8 rounded-xl border border-white/10 bg-white/[0.035] p-5"><div className="flex flex-wrap items-center justify-between gap-4"><div><h3 className="text-sm font-semibold text-white">Connection</h3><p className="mt-1 text-xs text-zinc-400">{status?.connected ? `Connected to ${status.connection?.google_email || "Google Drive"}` : "No Google Drive account connected yet."}</p></div>{!status?.connected ? <button type="button" onClick={() => void connect()} disabled={busy} className="rounded-lg bg-emerald-400 px-4 py-2.5 text-xs font-semibold text-black hover:bg-emerald-300 disabled:opacity-50">Connect Google Drive</button> : <span className="inline-flex items-center gap-1.5 text-xs text-emerald-300"><Check className="h-4 w-4" /> Connected</span>}</div></div>
      {status?.connected && <div className="mt-6 rounded-xl border border-white/10 bg-white/[0.035] p-5"><div className="flex items-center justify-between gap-3"><div><h3 className="text-sm font-semibold text-white">Export private CRM inventory</h3><p className="mt-1 text-xs text-zinc-400">Only selected records are exported. Contact numbers are never included.</p></div><button type="button" onClick={() => void createExport()} disabled={busy || !selected.length} className="rounded-lg bg-emerald-400 px-4 py-2.5 text-xs font-semibold text-black disabled:opacity-40">Export {selected.length || "selected"}</button></div><div className="mt-4 max-h-80 space-y-1 overflow-y-auto rounded-lg border border-white/10 p-2">{inventory.map((row) => <label key={row.id} className="flex cursor-pointer items-center gap-3 rounded-md px-3 py-2 text-xs text-zinc-300 hover:bg-white/5"><input type="checkbox" checked={selected.includes(row.id)} onChange={(event) => setSelected((current) => event.target.checked ? [...current, row.id] : current.filter((id) => id !== row.id))} /><span className="min-w-0 flex-1 truncate">{row.building_name || "Unnamed property"}{row.location ? ` · ${row.location}` : ""}</span><span className="text-zinc-500">{row.bhk || row.quote || ""}</span></label>)}{!inventory.length && <p className="px-3 py-6 text-center text-xs text-zinc-500">Add private inventory in CRM before creating an export.</p>}</div><p className="mt-4 text-xs text-zinc-400">To export shared-market listings, go to <Link href="/inbox" className="font-medium text-cyan-300 underline underline-offset-2">Market Inbox</Link> and select the listings you want.</p></div>}
      {!!status?.exports?.length && <div className="mt-6 space-y-2"><h3 className="text-sm font-semibold text-white">Exports</h3>{status.exports.map((item) => <div key={item.id} className="flex items-center justify-between gap-3 rounded-lg border border-white/10 px-4 py-3 text-xs"><span className="text-zinc-300">{item.file_name}</span><span className={item.last_error ? "text-amber-300" : "text-zinc-500"}>{item.last_error ? "Needs attention" : `${item.last_row_count} records · ${item.last_success_at ? "Synced" : "Queued"}`}</span></div>)}</div>}
      {message && <p className="mt-4 text-xs text-amber-300" role="status">{message}</p>}
    </section>
  );
}
