import { unstable_cache } from "next/cache";
import { getServerSupabase, slugify } from "@/lib/supabase";
import { getBuildingListings, type BuildingListing } from "@/lib/localities";

export type ProjectFact = {
  id: number;
  fact_name: string;
  value_json: unknown;
  last_seen_at: string;
  last_changed_at: string;
};

export type ProjectPageData = {
  project: {
    id: number;
    project_key: string;
    canonical_name: string;
    developer_name: string | null;
    locality: string | null;
    city: string | null;
    slug: string;
    building_id: number | null;
    identity_status: string;
    publication_status: string;
    last_crawled_at: string | null;
    last_fact_changed_at: string | null;
    last_activity_changed_at: string | null;
  };
  sources: Array<{ id: number; source_url: string; source_type: string; priority: number }>;
  facts: ProjectFact[];
  evidence: Array<{ fact_id: number; document_id: number; evidence_text: string; confidence: number }>;
  documents: Array<{ id: number; source_url: string; page_title: string | null; crawled_at: string }>;
  listings: BuildingListing[];
  buildingSlug: string | null;
};

function valueOf(facts: ProjectFact[], name: string): unknown {
  return facts.find((fact) => fact.fact_name === name)?.value_json ?? null;
}

function isFresh(lastCrawledAt: string | null): boolean {
  return !!lastCrawledAt && Date.now() - new Date(lastCrawledAt).getTime() <= 45 * 86400000;
}

async function fetchProject(rawLocality: string, rawSlug: string): Promise<ProjectPageData | null> {
  const db = getServerSupabase();
  const localitySlug = slugify(rawLocality);
  const projectSlug = slugify(rawSlug);
  if (!db || !localitySlug || !projectSlug) return null;

  const { data: projects, error } = await db
    .from("developer_projects")
    .select("id,project_key,canonical_name,developer_name,locality,city,slug,building_id,identity_status,publication_status,last_crawled_at,last_fact_changed_at,last_activity_changed_at")
    .eq("slug", projectSlug)
    .limit(20);
  if (error) return null;
  const project = (projects ?? []).find((row) => slugify(row.locality) === localitySlug);
  if (!project) return null;

  const [{ data: sources }, { data: facts }, { data: documents }] = await Promise.all([
    db.from("developer_project_sources").select("id,source_url,source_type,priority").eq("project_id", project.id).eq("enabled", true).order("priority"),
    db.from("developer_project_facts").select("id,fact_name,value_json,last_seen_at,last_changed_at").eq("project_id", project.id),
    db.from("developer_project_source_documents").select("id,source_url,page_title,crawled_at").eq("project_id", project.id).order("crawled_at", { ascending: false }).limit(20),
  ]);
  const { data: evidence } = (facts ?? []).length
    ? await db.from("developer_project_fact_evidence").select("fact_id,document_id,evidence_text,confidence").in("fact_id", (facts ?? []).map((fact) => fact.id))
    : { data: [] };

  let listings: BuildingListing[] = [];
  let buildingSlug: string | null = null;
  if (project.building_id) {
    const { data: building } = await db.from("buildings").select("canonical_name,micro_market").eq("id", project.building_id).maybeSingle();
    if (building?.canonical_name) {
      buildingSlug = slugify(building.canonical_name);
      listings = await getBuildingListings(building.canonical_name, building.micro_market, project.building_id);
    }
  }
  return {
    project,
    sources: sources ?? [],
    facts: facts ?? [],
    evidence: evidence ?? [],
    documents: documents ?? [],
    listings,
    buildingSlug,
  };
}

export const getProjectPage = unstable_cache(
  fetchProject,
  ["public-project-page"],
  { revalidate: 300 },
);

export async function getProjectsForSitemap() {
  const db = getServerSupabase();
  if (!db) return [];
  const { data } = await db.from("developer_projects").select("locality,slug,last_fact_changed_at,last_activity_changed_at,last_crawled_at,publication_status").eq("publication_status", "published").not("last_crawled_at", "is", null);
  return (data ?? []).filter((row) => isFresh(row.last_crawled_at));
}

export function projectFactValue(data: ProjectPageData, name: string): string | null {
  const value = valueOf(data.facts, name);
  if (value == null) return null;
  return Array.isArray(value) ? value.join(", ") : String(value);
}

export function projectIsIndexable(data: ProjectPageData): boolean {
  return data.project.publication_status === "published" && isFresh(data.project.last_crawled_at) && data.documents.length > 0 && data.facts.some((fact) => fact.fact_name === "project_name" || fact.fact_name === "locality");
}
