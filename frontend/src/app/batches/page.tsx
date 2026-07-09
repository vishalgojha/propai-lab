"use client";

import { useEffect, useState, useCallback } from "react";
import * as api from "@/lib/api";

function fmtDate(s: string) {
  try {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? s : d.toLocaleString();
  } catch { return s; }
}

const STATUS_BADGE: Record<string, string> = {
  pending: "badge-yellow",
  processing: "badge-blue",
  completed: "badge-green",
  applied: "badge-green",
  failed: "badge-red",
  cancelled: "badge-red",
};

function statusClass(s: string) {
  return STATUS_BADGE[s] || "badge-yellow";
}

export default function BatchesPage() {
  const [batches, setBatches] = useState<api.ObservationBatch[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [checkingId, setCheckingId] = useState<number | null>(null);
  const [applyingId, setApplyingId] = useState<number | null>(null);
  const [log, setLog] = useState<string>("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.listObservationBatches();
      setBatches(data);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const createBatch = async () => {
    setCreating(true);
    setLog("Creating batch...");
    try {
      const resp = await api.createObservationBatch(0);
      setLog(`Batch #${resp.id} created with ${resp.total_requests} requests (API: ${resp.batch_api_id})`);
      load();
    } catch (e: any) {
      setLog(`Error: ${e.message || e}`);
    } finally {
      setCreating(false);
    }
  };

  const checkStatus = async (id: number) => {
    setCheckingId(id);
    try {
      const resp = await api.checkBatchStatus(id);
      setLog(`Batch #${id}: ${resp.status} (completed: ${resp.completed ?? "?"}, failed: ${resp.failed ?? "?"})`);
      load();
    } catch (e: any) {
      setLog(`Error: ${e.message || e}`);
    } finally {
      setCheckingId(null);
    }
  };

  const applyResults = async (id: number) => {
    setApplyingId(id);
    try {
      const resp = await api.applyBatchResults(id);
      setLog(`Batch #${id}: merged ${resp.merged} observations (errors: ${resp.errors})`);
      load();
    } catch (e: any) {
      setLog(`Error: ${e.message || e}`);
    } finally {
      setApplyingId(null);
    }
  };

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold">Batch Observation Processor</h2>
        <button
          onClick={createBatch}
          disabled={creating}
          className="px-3 py-1.5 text-xs bg-[#3EE88A] text-[#090d12] rounded-lg font-semibold hover:bg-[#2dd47a] disabled:opacity-50"
        >
          {creating ? "Creating..." : "New Batch"}
        </button>
      </div>

      {log && (
        <div className="text-xs text-zinc-400 bg-zinc-900 border border-white/10 rounded-lg p-2.5 font-mono">
          {log}
        </div>
      )}

      <div className="text-xs text-zinc-500">
        Uses the OpenAI-compatible batch API on doubleword.ai — uploads all conversational messages as a JSONL file,
        processes them asynchronously, and merges extracted observations into the knowledge base. Typically completes
        within minutes for ~1000 messages.
      </div>

      {loading ? (
        <div className="text-xs text-zinc-500">Loading...</div>
      ) : batches.length === 0 ? (
        <div className="text-xs text-zinc-500">No batches yet. Click "New Batch" to start one.</div>
      ) : (
        <div className="space-y-2">
          {batches.map((b) => (
            <div
              key={b.id}
              className="bg-zinc-900 border border-white/10 rounded-xl p-3 text-xs space-y-2"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-white">Batch #{b.id}</span>
                  <span className={`badge ${statusClass(b.status)}`}>{b.status}</span>
                </div>
                <span className="text-zinc-500">{fmtDate(b.created_at)}</span>
              </div>

              <div className="grid grid-cols-4 gap-3 text-zinc-400">
                <div>
                  <span className="block text-[9px] text-zinc-500">Total</span>
                  {b.total_requests}
                </div>
                <div>
                  <span className="block text-[9px] text-zinc-500">Completed</span>
                  {b.completed_count}
                </div>
                <div>
                  <span className="block text-[9px] text-zinc-500">Failed</span>
                  {b.failed_count}
                </div>
                <div>
                  <span className="block text-[9px] text-zinc-500">API ID</span>
                  <span className="text-[10px] font-mono truncate block max-w-[160px]">{b.batch_api_id || "—"}</span>
                </div>
              </div>

              {b.error_message && (
                <div className="text-[#f87171] text-[10px]">{b.error_message}</div>
              )}

              <div className="flex items-center gap-2 pt-1">
                {b.status === "processing" && (
                  <button
                    onClick={() => checkStatus(b.id)}
                    disabled={checkingId === b.id}
                    className="px-2 py-1 text-[10px] bg-[#1d4ed8]/20 text-[#60a5fa] rounded-md hover:bg-[#1d4ed8]/30 disabled:opacity-50"
                  >
                    {checkingId === b.id ? "Checking..." : "Check Status"}
                  </button>
                )}
                {b.status === "completed" && (
                  <button
                    onClick={() => applyResults(b.id)}
                    disabled={applyingId === b.id}
                    className="px-2 py-1 text-[10px] bg-[#166534]/30 text-[#4ade80] rounded-md hover:bg-[#166534]/50 disabled:opacity-50"
                  >
                    {applyingId === b.id ? "Applying..." : "Apply Results"}
                  </button>
                )}
                {(b.status === "pending" || b.status === "created") && (
                  <button
                    onClick={() => checkStatus(b.id)}
                    disabled={checkingId === b.id}
                    className="px-2 py-1 text-[10px] bg-[#1d4ed8]/20 text-[#60a5fa] rounded-md hover:bg-[#1d4ed8]/30 disabled:opacity-50"
                  >
                    {checkingId === b.id ? "Checking..." : "Poll API"}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
