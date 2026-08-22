"use client";

export const dynamic = "force-dynamic";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { BookOpen, CheckCircle2, ChevronDown, ExternalLink, GitBranch, Network, RefreshCw, ShieldCheck, TriangleAlert } from "lucide-react";
import { fetchJSON } from "@/lib/api";

type ArchitecturePayload = {
  architecture: string;
  schema_diagram: string;
  dependency_diagram: string;
  openapi_path: string;
};

function sectionBody(markdown: string, heading: string): string {
  const match = markdown.match(new RegExp(`^## ${heading}\\n([\\s\\S]*?)(?=^## |$)`, "m"));
  return match?.[1]?.trim() || "Section unavailable.";
}

function CodePanel({ value, label }: { value: string; label: string }) {
  return (
    <details className="group rounded-xl border border-border-subtle bg-background">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-semibold text-text-primary">
        <span className="flex items-center gap-2"><GitBranch className="h-4 w-4 text-accent" />{label}</span>
        <ChevronDown className="h-4 w-4 text-text-muted transition-transform group-open:rotate-180" />
      </summary>
      <div className="border-t border-border-subtle p-4">
        <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap rounded-lg bg-[#101712] p-4 text-[11px] leading-5 text-emerald-100">{value}</pre>
        <p className="mt-3 text-xs text-text-muted">Generated Mermaid source. The same artifact renders natively in GitHub.</p>
      </div>
    </details>
  );
}

function MarkdownSection({ title, body, icon }: { title: string; body: string; icon: React.ReactNode }) {
  return (
    <details className="group rounded-2xl border border-border-subtle bg-surface-raised" open={title === "System map"}>
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-5 py-4 text-base font-semibold text-text-primary">
        <span className="flex items-center gap-2">{icon}{title}</span>
        <ChevronDown className="h-4 w-4 text-text-muted transition-transform group-open:rotate-180" />
      </summary>
      <div className="border-t border-border-subtle px-5 py-4">
        <pre className="whitespace-pre-wrap font-sans text-sm leading-6 text-text-secondary">{body}</pre>
      </div>
    </details>
  );
}

export default function ArchitecturePage() {
  const [data, setData] = useState<ArchitecturePayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    void fetchJSON<ArchitecturePayload>("/architecture", undefined, 30000)
      .then((next) => { setData(next); setError(null); })
      .catch((err) => setError(err instanceof Error ? err.message : "Architecture could not be loaded"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(load, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  return (
    <main className="min-h-full bg-background px-4 py-8 text-text-primary sm:px-6 lg:px-10">
      <div className="mx-auto max-w-6xl">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="propai-kicker text-[10px] font-semibold">Internal operating contract</p>
            <h1 className="mt-2 text-3xl font-semibold tracking-[-0.035em]">Living Architecture</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-text-secondary">The system map, invariants, landmines, and verification commands that keep PropAI understandable as it evolves.</p>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={load} className="inline-flex items-center gap-2 rounded-lg border border-border-subtle px-3 py-2 text-xs font-semibold text-text-secondary hover:border-accent/50 hover:text-text-primary"><RefreshCw className="h-3.5 w-3.5" />Refresh</button>
            <Link href="/api/docs" target="_blank" className="inline-flex items-center gap-2 rounded-lg bg-accent px-3 py-2 text-xs font-semibold text-[#07120c] hover:bg-accent-hover"><ExternalLink className="h-3.5 w-3.5" />OpenAPI</Link>
          </div>
        </div>

        {loading && <div className="mt-8 rounded-2xl border border-border-subtle bg-surface-raised p-5 text-sm text-text-muted">Loading architecture evidence…</div>}
        {error && <div className="mt-8 flex items-center gap-2 rounded-2xl border border-red-400/30 bg-red-400/10 p-5 text-sm text-red-700"><TriangleAlert className="h-4 w-4" />{error}</div>}
        {data && <>
          <div className="mt-8 grid gap-3 sm:grid-cols-3">
            <div className="rounded-2xl border border-border-subtle bg-surface-raised p-4"><ShieldCheck className="h-5 w-5 text-accent" /><p className="mt-3 text-sm font-semibold">Authenticated</p><p className="mt-1 text-xs text-text-muted">Workspace-only architecture evidence</p></div>
            <div className="rounded-2xl border border-border-subtle bg-surface-raised p-4"><Network className="h-5 w-5 text-accent" /><p className="mt-3 text-sm font-semibold">Generated maps</p><p className="mt-1 text-xs text-text-muted">Schema and module boundaries from source</p></div>
            <div className="rounded-2xl border border-border-subtle bg-surface-raised p-4"><CheckCircle2 className="h-5 w-5 text-accent" /><p className="mt-3 text-sm font-semibold">Verify, don’t trust</p><p className="mt-1 text-xs text-text-muted">Copy-paste checks live beside each rule</p></div>
          </div>

          <section className="mt-8 space-y-3" aria-label="Generated diagrams">
            <h2 className="text-xs font-bold uppercase tracking-[0.16em] text-text-muted">Generated maps</h2>
            <CodePanel value={data.schema_diagram} label="Database ER diagram" />
            <CodePanel value={data.dependency_diagram} label="Backend and frontend dependency map" />
          </section>

          <section className="mt-8 space-y-3" aria-label="Architecture contract">
            <h2 className="text-xs font-bold uppercase tracking-[0.16em] text-text-muted">Architecture contract</h2>
            <MarkdownSection title="System map" body={sectionBody(data.architecture, "System map")} icon={<Network className="h-4 w-4 text-accent" />} />
            <MarkdownSection title="Data model conventions" body={sectionBody(data.architecture, "Data model conventions")} icon={<ShieldCheck className="h-4 w-4 text-accent" />} />
            <MarkdownSection title="Known landmines and open risk log" body={sectionBody(data.architecture, "Known landmines and open risk log")} icon={<TriangleAlert className="h-4 w-4 text-amber-600" />} />
            <MarkdownSection title="Verification playbook" body={sectionBody(data.architecture, "Verification playbook")} icon={<CheckCircle2 className="h-4 w-4 text-accent" />} />
            <MarkdownSection title="Decision log" body={sectionBody(data.architecture, "Decision log")} icon={<BookOpen className="h-4 w-4 text-accent" />} />
            <MarkdownSection title="Maintenance contract" body={sectionBody(data.architecture, "Maintenance contract")} icon={<GitBranch className="h-4 w-4 text-accent" />} />
          </section>
        </>}
      </div>
    </main>
  );
}
