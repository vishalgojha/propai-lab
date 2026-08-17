"use client";

import { useSearchParams } from "next/navigation";
import { GroupedTabs } from "@/components/GroupedTabs";
import { AdminProvidersPage } from "../providers/page";
import { BuildingEnrichmentPage } from "../building-enrichment/page";
import { SemanticEmbeddingsPage } from "../semantic-embeddings/page";

const tabs = [{ id: "providers", label: "Provider Health" }, { id: "enrichment", label: "Building Enrichment" }, { id: "embeddings", label: "Semantic Embeddings" }];

export default function PipelineHealthPage() {
  const params = useSearchParams();
  const active = tabs.some((tab) => tab.id === params.get("tab")) ? params.get("tab")! : "providers";
  return <main className="propai-admin-page"><div className="propai-admin-heading mx-auto max-w-7xl px-4 pt-8 lg:px-7"><div className="propai-kicker">System observability</div><h1 className="mb-1 text-2xl font-semibold text-white">Pipeline Health</h1><p className="mb-6 text-sm text-zinc-500">Internal diagnostics for PropAI’s data pipeline.</p><GroupedTabs tabs={tabs} active={active} /></div>{active === "enrichment" ? <BuildingEnrichmentPage /> : active === "embeddings" ? <SemanticEmbeddingsPage /> : <AdminProvidersPage />}</main>;
}
