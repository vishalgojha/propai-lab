"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { fetchJSON } from "@/lib/api";

type Kind = "workspaces" | "accounts";
type Row = {id: string; name?: string; email?: string; phone?: string; owner_phone?: string; owner_user_id?: string; owner_user_source?: string | null; owner_phone_source?: string | null; created_at?: string; last_sign_in_at?: string; email_confirmed_at?: string; phone_confirmed_at?: string; is_active?: boolean};
type Directory = {kind: Kind; rows: Row[]; page: number; page_size: number; has_more: boolean; total: number | null; as_of: string};
const date = (value?: string) => value ? new Date(value).toLocaleString("en-IN", {timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short"}) : "Not recorded";

export default function UsersPage() {
  const [kind, setKind] = useState<Kind>("workspaces");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Directory | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [filter, setFilter] = useState("");
  const request = useRef(0);
  useEffect(() => {
    const id = ++request.current;
    setData(null); setError(""); setLoading(true); setFilter("");
    fetchJSON<Directory>(`/admin/user-directory?kind=${kind}&page=${page}&page_size=25`)
      .then(value => {if (request.current === id) setData(value);})
      .catch(err => {if (request.current === id) setError(err instanceof Error ? err.message : "Directory could not be loaded");})
      .finally(() => {if (request.current === id) setLoading(false);});
    return () => {request.current++;};
  }, [kind, page, revision]);
  const rows = (data?.rows || []).filter(row => [row.name, row.email, row.phone, row.owner_phone, row.id, row.owner_user_id].join(" ").toLowerCase().includes(filter.toLowerCase()));
  const button = "rounded-lg border border-[var(--border)] px-4 py-2 text-sm disabled:opacity-40";
  return <div className="mx-auto w-full min-w-0 max-w-6xl space-y-6 p-4 lg:p-8">
    <Link href="/admin" className="text-sm text-[var(--text-secondary)]">← Admin</Link>
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div><p className="text-xs uppercase tracking-widest text-[var(--text-secondary)]">Private admin directory</p><h1 className="mt-2 text-3xl font-semibold">Signups &amp; users</h1><p className="mt-2 text-sm text-[var(--text-secondary)]">Read-only. Access is checked on the server for every request.</p></div>
      <button className={button} disabled={loading} onClick={() => setRevision(v => v + 1)}>Refresh</button>
    </header>
    <div className="grid gap-3 sm:grid-cols-2" role="tablist" aria-label="Directory type">
      {(["workspaces", "accounts"] as Kind[]).map(value => <button key={value} role="tab" aria-selected={kind === value} onClick={() => {setKind(value); setPage(1);}} className={`rounded-xl border p-4 text-left ${kind === value ? "border-[var(--signal-lime)] bg-[var(--surface-raised)]" : "border-[var(--border)]"}`}><span className="font-semibold">{value === "workspaces" ? "Workspace signups" : "User accounts"}</span><span className="mt-1 block text-xs text-[var(--text-secondary)]">{value === "workspaces" ? "Created workspaces, newest first" : "Authentication accounts, provider order"}</span></button>)}
    </div>
    <section className="rounded-xl border border-[var(--border)] bg-[var(--surface-raised)] p-4 text-sm text-[var(--text-secondary)]">
      {kind === "workspaces" ? "A signup here means a workspace was created. It is not a count of all registered accounts, logins or active users." : "An account may exist without a workspace. Last sign-in is an authentication event, not proof of product activity. Missing values are shown as not recorded."}
      <p className="mt-2">Dates are shown in India Standard Time (IST). No account changes can be made here.</p>
    </section>
    {loading ? <p role="status" className="py-12 text-center">Loading directory…</p> : error ? <div role="alert" className="rounded-xl border border-red-500/40 p-5"><p>{error}</p><button className={`${button} mt-4`} onClick={() => setRevision(v => v + 1)}>Retry</button></div> : data && <>
      <div className="flex flex-wrap items-center justify-between gap-3"><div><p className="font-medium">{data.total !== null ? `${data.total.toLocaleString()} ${data.total === 1 ? "workspace" : "workspaces"}` : `${data.rows.length} ${data.rows.length === 1 ? "account" : "accounts"} on this page`}</p><p className="text-xs text-[var(--text-secondary)]">Updated {date(data.as_of)}</p></div><label className="flex w-full min-w-0 flex-col gap-2 text-sm sm:w-auto sm:flex-row sm:items-center">Filter this page<input aria-label="Filter this page" value={filter} onChange={e => setFilter(e.target.value)} placeholder="Name, contact or ID" className="w-full min-w-0 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-2" /></label></div>
      {!rows.length ? <p className="rounded-xl border border-[var(--border)] p-8 text-center">{filter ? "No matches on this page. Clear the filter or check another page." : "No records on this page."}</p> : <div className="space-y-3">{rows.map(row => <article key={row.id} className="rounded-xl border border-[var(--border)] p-4 sm:p-5"><div className="flex flex-wrap justify-between gap-2"><h2 className="font-semibold">{row.name || (kind === "accounts" ? "Name not recorded" : "Unnamed workspace")}</h2>{kind === "workspaces" && <span className="text-xs text-[var(--text-secondary)]">{row.is_active === true ? "Workspace enabled" : row.is_active === false ? "Workspace disabled" : "Status not recorded"}</span>}</div><dl className="mt-4 grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-3"><Field label={kind === "workspaces" ? "Owner phone" : "Email"} value={kind === "workspaces" ? (row.owner_phone ? `${row.owner_phone}${row.owner_phone_source === "signup_entry" ? " (entered at signup, not verified)" : row.owner_phone_source === "auth_unconfirmed" ? " (not confirmed)" : row.owner_phone_source === "verified_auth" ? " (verified)" : ""}` : row.owner_user_id ? "Phone unavailable" : "Owner not linked") : row.email} /><Field label={kind === "workspaces" ? "Owner user ID" : "Phone"} value={kind === "workspaces" ? (row.owner_user_id ? `${row.owner_user_id}${row.owner_user_source === "owner_membership" ? " (from owner membership)" : ""}` : "Owner not linked") : row.phone} /><Field label={kind === "workspaces" ? "Workspace created" : "Account registered"} value={date(row.created_at)} />{kind === "accounts" && <><Field label="Last sign-in" value={date(row.last_sign_in_at)} /><Field label="Email confirmed" value={date(row.email_confirmed_at)} /><Field label="Phone confirmed" value={date(row.phone_confirmed_at)} /></>}</dl><p className="mt-4 break-all border-t border-[var(--border)] pt-3 text-xs text-[var(--text-secondary)]">{kind === "workspaces" ? "Workspace" : "User"} ID: {row.id}</p></article>)}</div>}
      <nav aria-label="Directory pages" className="flex items-center justify-between gap-3"><button className={button} disabled={page === 1} onClick={() => setPage(v => v - 1)}>Previous</button><span className="text-sm">Page {page}</span><button className={button} disabled={!data.has_more} onClick={() => setPage(v => v + 1)}>Next</button></nav>
    </>}
  </div>;
}
function Field({label, value}: {label: string; value?: string}) { return <div className="min-w-0"><dt className="text-xs text-[var(--text-secondary)]">{label}</dt><dd className="mt-1 break-words [overflow-wrap:anywhere]">{value || "Not recorded"}</dd></div>; }
