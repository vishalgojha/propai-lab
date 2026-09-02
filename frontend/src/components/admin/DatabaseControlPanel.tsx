"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, Code2, Database, Pencil, Play, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { fetchJSON } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

type TableMeta = { name: string; group_name: string; row_count: number; is_legacy: boolean };
type FunctionMeta = { name: string; arguments: string; security_definer: boolean };
type TableResponse = { rows: Record<string, unknown>[]; columns: string[]; total: number };

function pretty(value: unknown) {
  return JSON.stringify(value ?? {}, null, 2);
}

function safeParse(text: string) {
  const value = JSON.parse(text);
  if (!value || Array.isArray(value) || typeof value !== "object") throw new Error("Enter a JSON object of field values.");
  return value as Record<string, unknown>;
}

export function DatabaseControlPanel({ tables, functions }: { tables: TableMeta[]; functions: FunctionMeta[] }) {
  const [tableName, setTableName] = useState(tables[0]?.name || "");
  const [table, setTable] = useState<TableResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editor, setEditor] = useState("{}");
  const [showNew, setShowNew] = useState(false);
  const [functionName, setFunctionName] = useState(functions[0]?.name || "");
  const [functionArgs, setFunctionArgs] = useState("{}");
  const [functionResult, setFunctionResult] = useState<unknown>(null);

  const selected = useMemo(() => tables.find((item) => item.name === tableName), [tableName, tables]);

  async function loadTable(name = tableName) {
    if (!name) return;
    setLoading(true); setError("");
    try { setTable(await fetchJSON<TableResponse>(`/admin/supabase-table/${encodeURIComponent(name)}?limit=50&offset=0`)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Records could not be loaded."); }
    finally { setLoading(false); }
  }

  useEffect(() => { void loadTable(); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tableName]);

  function beginEdit(row: Record<string, unknown>) {
    setEditingId(String(row.id ?? "")); setEditor(pretty(row)); setShowNew(false); setError("");
  }

  function cancelEdit() { setEditingId(null); setShowNew(false); setEditor("{}"); }

  async function saveRow() {
    if (!tableName) return;
    setSaving(true); setError("");
    try {
      const values = safeParse(editor);
      if (editingId) await fetchJSON(`/admin/supabase-table/${encodeURIComponent(tableName)}/${encodeURIComponent(editingId)}`, { method: "PATCH", body: JSON.stringify({ values }) });
      else await fetchJSON(`/admin/supabase-table/${encodeURIComponent(tableName)}`, { method: "POST", body: JSON.stringify({ values }) });
      cancelEdit(); await loadTable();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Record could not be saved."); }
    finally { setSaving(false); }
  }

  async function deleteRow(row: Record<string, unknown>) {
    const id = String(row.id ?? "");
    if (!id || !window.confirm(`Delete record ${id} from ${tableName}? This cannot be undone.`)) return;
    setSaving(true); setError("");
    try { await fetchJSON(`/admin/supabase-table/${encodeURIComponent(tableName)}/${encodeURIComponent(id)}`, { method: "DELETE" }); await loadTable(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Record could not be deleted."); }
    finally { setSaving(false); }
  }

  async function runFunction() {
    setSaving(true); setError(""); setFunctionResult(null);
    try { setFunctionResult((await fetchJSON<{ result: unknown }>(`/admin/supabase-function/${encodeURIComponent(functionName)}`, { method: "POST", body: JSON.stringify({ arguments: safeParse(functionArgs) }) })).result); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Function could not be run."); }
    finally { setSaving(false); }
  }

  const columns = table?.columns?.length ? table.columns : (table?.rows[0] ? Object.keys(table.rows[0]) : []);
  return <section id="data-control" className="scroll-mt-6 space-y-4">
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div><div className="flex items-center gap-2"><Database className="h-4 w-4 text-[#287D82]" /><h2 className="text-[15px] font-semibold text-[#16252B]">Database control</h2></div><p className="mt-1 text-xs text-[#49615F]">Full Super Admin CRUD through PropAI. Every action is authenticated and limited to the live public catalog.</p></div>
      <Badge variant="outline" className="border-[#2F6B3A]/30 bg-[#2F6B3A]/10 text-[#2F6B3A]">Primary admin only</Badge>
    </div>
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
      <div className="overflow-hidden rounded-xl border border-[rgba(22,37,43,.14)] bg-[#F6FBF9]">
        <div className="flex flex-wrap items-center gap-2 border-b border-[rgba(22,37,43,.1)] p-3"><select value={tableName} onChange={(event) => { setTableName(event.target.value); cancelEdit(); }} className="h-9 min-w-[240px] flex-1 rounded-md border border-[rgba(22,37,43,.18)] bg-white px-3 text-xs text-[#16252B]">{tables.map((item) => <option key={item.name} value={item.name}>{item.name} · {item.row_count.toLocaleString("en-IN")} rows</option>)}</select><Button variant="outline" size="sm" onClick={() => void loadTable()} disabled={loading}><RefreshCw className={loading ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"} />Refresh</Button><Button size="sm" onClick={() => { setShowNew(true); setEditingId(null); setEditor("{}"); }}><Plus className="h-3.5 w-3.5" />New record</Button></div>
        {selected && <div className="border-b border-[rgba(22,37,43,.1)] px-4 py-2 text-[11px] text-[#49615F]">{selected.group_name} · {table?.total?.toLocaleString("en-IN") ?? "—"} records loaded from <span className="font-mono text-[#16252B]">{tableName}</span></div>}
        {error && <div role="alert" className="m-3 rounded-md border border-[#A9362E]/25 bg-[#FFF7F5] px-3 py-2 text-xs text-[#7D2B25]">{error}</div>}
        {loading && <div className="space-y-2 p-4" aria-busy="true">{[1,2,3,4].map((item) => <div key={item} className="h-10 animate-pulse rounded-md bg-[#DDE8E5]" />)}</div>}
        {!loading && !table?.rows.length && <div className="p-8 text-center text-xs text-[#49615F]">No records in this data area yet. Use New record to add one.</div>}
        {!loading && !!table?.rows.length && <div className="max-h-[520px] overflow-auto"><table className="w-full min-w-[760px] text-left text-xs"><thead className="sticky top-0 bg-[#EAF3F0] text-[10px] uppercase tracking-[.12em] text-[#49615F]"><tr>{columns.map((column) => <th key={column} className="px-3 py-3">{column.replaceAll("_", " ")}</th>)}<th className="sticky right-0 bg-[#EAF3F0] px-3 py-3 text-right">Actions</th></tr></thead><tbody>{table.rows.map((row, index) => <tr key={String(row.id ?? index)} className="border-t border-[rgba(22,37,43,.08)] align-top hover:bg-white"><>{columns.map((column) => <td key={column} className="max-w-[260px] px-3 py-3 text-[#16252B]">{row[column] == null ? <span className="text-[#7B9290]">—</span> : typeof row[column] === "object" ? <span className="font-mono text-[10px]">{JSON.stringify(row[column])}</span> : String(row[column])}</td>)}</><td className="sticky right-0 bg-inherit px-3 py-3"><div className="flex justify-end gap-1"><Button variant="ghost" size="icon" aria-label="Edit record" onClick={() => beginEdit(row)}><Pencil className="h-3.5 w-3.5" /></Button><Button variant="ghost" size="icon" aria-label="Delete record" onClick={() => void deleteRow(row)} disabled={saving}><Trash2 className="h-3.5 w-3.5 text-[#A9362E]" /></Button></div></td></tr>)}</tbody></table></div>}
      </div>
      <div className="space-y-4">
        {(editingId || showNew) && <div className="rounded-xl border border-[#287D82]/30 bg-white p-4"><div className="flex items-center justify-between gap-2"><div><h3 className="text-sm font-semibold text-[#16252B]">{editingId ? `Edit record ${editingId}` : "New record"}</h3><p className="mt-1 text-[11px] text-[#49615F]">Send a JSON object with the fields you want to write.</p></div><Button variant="ghost" size="icon" aria-label="Close editor" onClick={cancelEdit}><X className="h-4 w-4" /></Button></div><textarea value={editor} onChange={(event) => setEditor(event.target.value)} className="mt-3 min-h-[240px] w-full rounded-md border border-[rgba(22,37,43,.18)] bg-[#102126] p-3 font-mono text-xs text-[#DDE8E5] outline-none focus:border-[#287D82]" spellCheck={false} /><Button className="mt-3 w-full" onClick={() => void saveRow()} disabled={saving}>{saving ? "Saving…" : editingId ? "Save changes" : "Create record"}</Button></div>}
        <div className="rounded-xl border border-[rgba(22,37,43,.14)] bg-white p-4"><div className="flex items-center gap-2"><Code2 className="h-4 w-4 text-[#287D82]" /><div><h3 className="text-sm font-semibold text-[#16252B]">Run a database function</h3><p className="mt-1 text-[11px] text-[#49615F]">Only catalogued functions are available; triggers stay protected.</p></div></div><select value={functionName} onChange={(event) => setFunctionName(event.target.value)} className="mt-3 h-9 w-full rounded-md border border-[rgba(22,37,43,.18)] bg-white px-3 text-xs text-[#16252B]">{functions.filter((item) => !item.name.startsWith("trg_") && !item.name.startsWith("trigger_") && !item.name.startsWith("touch_")).map((item) => <option key={item.name} value={item.name}>{item.name}({item.arguments})</option>)}</select><textarea value={functionArgs} onChange={(event) => setFunctionArgs(event.target.value)} className="mt-3 min-h-[100px] w-full rounded-md border border-[rgba(22,37,43,.18)] bg-[#102126] p-3 font-mono text-xs text-[#DDE8E5] outline-none focus:border-[#287D82]" spellCheck={false} /><Button variant="outline" className="mt-3 w-full" onClick={() => void runFunction()} disabled={saving || !functionName}><Play className="h-3.5 w-3.5" />Run function</Button>{functionResult !== null && <div className="mt-3 rounded-md bg-[#EAF3F0] p-3"><div className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-[.12em] text-[#2F6B3A]"><Check className="h-3.5 w-3.5" />Result</div><pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] text-[#16252B]">{pretty(functionResult)}</pre></div>}</div>
      </div>
    </div>
  </section>;
}
