const BASE = "/api";
const API_TIMEOUT_MS = 8000;

async function fetchJSON<T>(url: string, init?: RequestInit, timeoutMs = API_TIMEOUT_MS): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}${url}`, {
      ...init,
      signal: init?.signal || controller.signal,
      headers: { "Content-Type": "application/json", ...init?.headers },
    });
    if (!res.ok) {
      const body = await res.text();
      let message = body;
      try {
        const parsed = JSON.parse(body);
        message = parsed.message || parsed.detail || body;
      } catch {
        message = body;
      }
      throw new Error(`${res.status} ${res.statusText}: ${message}`);
    }
    return res.json();
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error(`Request timed out: ${url}`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export interface RawMessage {
  id: number;
  group_name: string;
  sender: string;
  sender_jid?: string;
  sender_phone?: string;
  message: string;
  message_type: string;
  timestamp: string;
  source: string;
  event_id: string;
  message_uid: string;
  raw_payload: string;
  synced_at: string;
  pipeline_version: string;
}

export interface ParsedObservation {
  id: number;
  raw_message_id: number;
  raw_group: string;
  raw_timestamp: string;
  broker_name: string;
  broker_phone: string;
  intent: string;
  principal: string;
  forwarded: boolean;
  bhk: string;
  price: number;
  price_unit: string;
  area_sqft: number;
  furnishing: string;
  location_raw: string;
  location: { tokens?: { text: string; kind: string }[] } | null;
  landmark_name: string;
  building_name: string;
  micro_market: string;
  street_name: string;
  developer: string;
  confidence: number;
  created_at: string;
}

export interface DashboardActivity {
  messages_today: number;
  message_types: Record<string, number>;
}

export interface DashboardCoverage {
  groups_connected: number;
  messages_stored: number;
  listings_known?: number;
  buildings_known: number;
  landmarks_known: number;
  developers_known: number;
  micro_markets_known: number;
}

export interface ListingRow {
  id: number;
  fingerprint: string;
  intent: string;
  bhk: string;
  price: number;
  price_unit: string;
  area_sqft: number;
  furnishing: string;
  location_label: string;
  building_name: string;
  landmark_name: string;
  micro_market: string;
  broker_name: string;
  broker_phone: string;
  first_seen: string;
  last_seen: string;
  observation_count: number;
  group_count: number;
  latest_raw_message_id: number;
  representative_raw_message_id: number;
  latest_timestamp: string;
  latest_group: string;
}

export interface ConnectionState {
  state: string;
  connected: boolean;
}

export interface WhatsAppStatus {
  connected: boolean;
  phone: string;
  profile: string;
  instance: string;
  state: string;
  connected_since: string;
}

export function getRaw(limit = 50, offset = 0, group_name?: string, sender?: string, sender_phone?: string, sender_jid?: string) {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  if (group_name) params.set("group_name", group_name);
  if (sender) params.set("sender", sender);
  if (sender_phone) params.set("sender_phone", sender_phone);
  if (sender_jid) params.set("sender_jid", sender_jid);
  return fetchJSON<RawMessage[]>(`/raw?${params.toString()}`);
}

export function getParsed(limit = 50, offset = 0) {
  return fetchJSON<ParsedObservation[]>(`/parsed?limit=${limit}&offset=${offset}`);
}

export function getListings(limit = 50, offset = 0) {
  return fetchJSON<ListingRow[]>(`/listings?limit=${limit}&offset=${offset}`);
}

export function getDashboardActivity() {
  return fetchJSON<DashboardActivity>("/dashboard/activity");
}

export function getDashboardCoverage() {
  return fetchJSON<DashboardCoverage>("/dashboard/coverage");
}

export function getDashboardFeed(limit = 20) {
  return fetchJSON<any[]>(`/dashboard/feed?limit=${limit}`);
}

export function getDashboardHeatmap() {
  return fetchJSON<any[]>("/dashboard/heatmap");
}

export function getStats() {
  return fetchJSON<any>("/stats");
}

export function getSyncActivity() {
  return fetchJSON<any>("/dashboard/sync-activity");
}

export function getWhatsAppStatus() {
  return fetchJSON<WhatsAppStatus>("/dashboard/whatsapp-status");
}

export function getSourceStatus() {
  return fetchJSON<any>("/sources/status");
}

export function getConnectionState() {
  return fetchJSON<ConnectionState>("/sync/connection-state");
}

export function getConnectionDetail() {
  return fetchJSON<any>("/sync/connection");
}

export function getQR() {
  return fetchJSON<any>("/sync/qr");
}

export function logout() {
  return fetchJSON<any>("/sync/logout", { method: "POST" });
}

export function startSync() {
  return fetchJSON<any>("/sources/whatsapp/sync", { method: "POST" });
}

export function stopSync() {
  return fetchJSON<any>("/sources/stop", { method: "POST" });
}

export function getObservation(id: number) {
  return fetchJSON<any>(`/observations/${id}`);
}

export function getGroups() {
  return fetchJSON<any[]>("/groups");
}

export function getBuildings(limit = 100, offset = 0) {
  return fetchJSON<any>(`/buildings?limit=${limit}&offset=${offset}`);
}

export function discoverBuildingAliases(minConfidence = 0.7) {
  return fetchJSON<{ discovered: number; saved: number; suggestions: any[] }>(
    `/buildings/aliases/discover?min_confidence=${minConfidence}`,
    { method: "POST" }
  );
}

export function getAliasSuggestions(status = "pending", limit = 50) {
  return fetchJSON<{ suggestions: any[]; count: number }>(
    `/buildings/aliases/suggestions?status=${status}&limit=${limit}`
  );
}

export function reviewAliasSuggestion(suggestionId: number, approved: boolean) {
  return fetchJSON<{ success: boolean }>(
    `/buildings/aliases/${suggestionId}/review?approved=${approved}`,
    { method: "POST" }
  );
}

export function getAliasStats() {
  return fetchJSON<{
    total_suggestions: number;
    pending: number;
    approved: number;
    rejected: number;
    aliases_in_kb: number;
  }>("/buildings/aliases/stats");
}

export function getBrokers() {
  return fetchJSON<any[]>("/brokers");
}

export function getBroker(id: number) {
  return fetchJSON<any>(`/brokers/${id}`);
}

export function findBroker(name: string, phone: string) {
  const params = new URLSearchParams();
  if (name) params.set("name", name);
  if (phone) params.set("phone", phone);
  return fetchJSON<{ broker_id: number }>(`/brokers/find?${params.toString()}`);
}

export function getPriceStats(market = "", bhk = "", intent = "listing") {
  const params = new URLSearchParams();
  if (market) params.set("market", market);
  if (bhk) params.set("bhk", bhk);
  params.set("intent", intent);
  return fetchJSON<any>(`/price-stats?${params.toString()}`);
}

export function searchMessages(q: string) {
  return fetchJSON<any>(`/search?q=${encodeURIComponent(q)}`);
}

export interface RawSearchResult {
  id: number;
  group_name: string;
  sender: string;
  sender_phone: string;
  message: string;
  timestamp: string;
  source: string;
  snippet: string;
}

export function searchRawMessages(q: string, limit = 20, offset = 0) {
  return fetchJSON<{ results: RawSearchResult[]; count: number; query: string }>(
    `/search/raw?q=${encodeURIComponent(q)}&limit=${limit}&offset=${offset}`
  );
}

export function searchRawBySender(sender: string, limit = 50) {
  return fetchJSON<{ results: RawSearchResult[]; count: number; query: string }>(
    `/search/raw/sender?sender=${encodeURIComponent(sender)}&limit=${limit}`
  );
}

export function searchRawByGroup(groupJid: string, limit = 50) {
  return fetchJSON<{ results: RawSearchResult[]; count: number; query: string }>(
    `/search/raw/group?group_jid=${encodeURIComponent(groupJid)}&limit=${limit}`
  );
}

export function getBuildingProfile(buildingId: string) {
  return fetchJSON<any>(`/buildings/${encodeURIComponent(buildingId)}`);
}

export function getBuildingAliases(buildingId: string) {
  return fetchJSON<any[]>(`/buildings/${encodeURIComponent(buildingId)}/aliases`);
}

export function refreshBuilding(buildingId: string, provider?: string) {
  const params = provider ? `?provider=${provider}` : "";
  return fetchJSON<any>(`/buildings/${encodeURIComponent(buildingId)}/refresh${params}`, {
    method: "POST",
  });
}

export function discoverBuildings() {
  return fetchJSON<any>("/buildings/discover", { method: "POST" });
}

export function refreshBuildingCounts() {
  return fetchJSON<any>("/buildings/refresh-counts", { method: "POST" });
}

export function getBuildingEnrichmentDashboard() {
  return fetchJSON<any>("/buildings/enrichment/dashboard");
}

export function getBuildingEnrichmentJobs(status?: string, limit = 50) {
  const params = new URLSearchParams();
  if (status) params.set("status", status);
  params.set("limit", String(limit));
  return fetchJSON<any[]>(`/buildings/enrichment/jobs?${params.toString()}`);
}

export function getBuildingEnrichmentHistory(buildingId?: string, limit = 50) {
  const params = new URLSearchParams();
  if (buildingId) params.set("building_id", buildingId);
  params.set("limit", String(limit));
  return fetchJSON<any[]>(`/buildings/enrichment/history?${params.toString()}`);
}

export function getIGRDistricts(restOfMaharashtra = true) {
  return fetchJSON<any[]>(`/igr/districts?rest_of_maharashtra=${restOfMaharashtra}`);
}

export function getIGRTahsils(districtCode: string) {
  return fetchJSON<any[]>(`/igr/tahsils?district_code=${districtCode}`);
}

export function getIGRVillages(districtCode: string, tahsilCode: string) {
  return fetchJSON<any[]>(`/igr/villages?district_code=${districtCode}&tahsil_code=${encodeURIComponent(tahsilCode)}`);
}

export function searchIGR(params: {
  district_code?: string;
  tahsil_code?: string;
  village?: string;
  property_no?: string;
  year?: number;
}) {
  const sp = new URLSearchParams();
  if (params.district_code) sp.set("district_code", params.district_code);
  if (params.tahsil_code) sp.set("tahsil_code", params.tahsil_code);
  if (params.village) sp.set("village", params.village);
  if (params.property_no) sp.set("property_no", params.property_no);
  if (params.year) sp.set("year", String(params.year));
  return fetchJSON<any>(`/igr/search?${sp.toString()}`);
}

export function getMarketDetail(name: string) {
  return fetchJSON<any>(`/markets/${encodeURIComponent(name)}`);
}

export function getActionDashboard() {
  return fetchJSON<any>("/action/dashboard");
}

export function getChatSuggestions() {
  return fetchJSON<any>("/suggestions/counts");
}

export function getResolver(limit = 50, offset = 0, method?: string) {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  if (method) params.set("method", method);
  return fetchJSON<any[]>(`/resolver?${params}`);
}

export function getFailed(limit = 50, offset = 0) {
  return fetchJSON<any[]>(`/failed?limit=${limit}&offset=${offset}`);
}

export function getGraphGrowth() {
  return fetchJSON<any>("/dashboard/graph-growth");
}

export interface ChatResponse {
  content: string;
  blocks: WorkspaceBlock[];
  sources: string[];
  status_steps?: string[];
  trace?: {
    sources?: string[];
    last_updated?: string;
    notes?: string[];
  };
}

export interface WorkspaceBlockAction {
  label: string;
  value?: string;
  href?: string;
  kind?: string;
}

export interface WorkspaceBlockMetric {
  label: string;
  value: string;
  tone?: "neutral" | "good" | "warn" | "bad" | "accent";
}

export interface WorkspaceBlock {
  type:
    | "summary"
    | "listing_cards"
    | "buyer_cards"
    | "broker_cards"
    | "building_card"
    | "market_card"
    | "table"
    | "timeline"
    | "map"
    | "comparison"
    | "original_messages"
    | "ai_suggestions"
    | "charts"
    | "export_panel"
    | "promotion_preview"
    | "property_gallery"
    | "related_listings"
    | "matching_buyers"
    | "suggested_questions"
    | "error_state"
    | "empty_state"
    | "loading"
    | string;
  title?: string;
  subtitle?: string;
  body?: string;
  summary?: string;
  description?: string;
  note?: string;
  items?: any[];
  results?: any[];
  rows?: any[];
  columns?: string[];
  metrics?: WorkspaceBlockMetric[];
  bullets?: string[];
  actions?: WorkspaceBlockAction[];
  cards?: any[];
  events?: any[];
  questions?: string[];
  sources?: string[];
  status_steps?: string[];
  status?: string;
  content?: string;
  prompt?: string;
  channels?: any[];
  steps?: string[];
  highlights?: string[] | string;
  hashtags?: string[] | string;
  cta?: string;
  headline?: string;
}

export interface AIConfig {
  has_server_key: boolean;
  base_url: string;
  model: string;
}

export function getAIConfig() {
  return fetchJSON<AIConfig>("/ai/config");
}

export function chatAIChat(
  messages: { role: string; content: string }[],
  apiKey = "",
  model = ""
): Promise<ChatResponse> {
  return fetchJSON<ChatResponse>(
    "/ai/chat",
    {
      method: "POST",
      body: JSON.stringify({ messages, api_key: apiKey, model }),
    },
    120000,
  );
}

export function searchListings(params: {
  intent?: string;
  bhk?: string;
  building?: string;
  micro_market?: string;
  price_max?: number;
  price_min?: number;
  furnishing?: string;
  broker?: string;
  sort_by?: string;
  limit?: number;
  offset?: number;
  group_by_building?: boolean;
}): Promise<any> {
  const searchParams = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "" && v !== null) {
      searchParams.set(k, String(v));
    }
  }
  return fetchJSON<any>(`/search/listings?${searchParams}`);
}

export function getListingSources(listingId: number) {
  return fetchJSON<any[]>(`/listings/${listingId}/sources`);
}

export function getParsedSources(parsedId: number) {
  return fetchJSON<any[]>(`/parsed/${parsedId}/sources`);
}

export function getDashboardListings(limit = 20) {
  return fetchJSON<any[]>(`/dashboard/listings?limit=${limit}`);
}

export function getDashboardRequirements(limit = 20) {
  return fetchJSON<any[]>(`/dashboard/requirements?limit=${limit}`);
}

export function matchRequirements() {
  return fetchJSON<{ matched: number }>("/requirements/match", { method: "POST" });
}

export function getRequirementMatchesSummary() {
  return fetchJSON<Record<string, { count: number; best: number }>>("/requirements/matches/summary");
}

export function getRequirementMatches(reqId: number, limit = 20) {
  return fetchJSON<{ requirement_id: number; matches: any[]; count: number }>(
    `/requirements/${reqId}/matches?limit=${limit}`
  );
}

export function getDashboardSignals() {
  return fetchJSON<any>("/dashboard/signals");
}

export function getAllowlist() {
  return fetchJSON<string[]>("/groups/allowlist");
}

export function setAllowlist(entries: string[]) {
  return fetchJSON<any>("/groups/allowlist", {
    method: "POST",
    body: JSON.stringify(entries),
  });
}

export function clearAllowlist() {
  return fetchJSON<any>("/groups/allowlist", { method: "DELETE" });
}

// ── AI Suggestions ──────────────────────────────────────────────

export function getSuggestions(status = "pending", limit = 50, offset = 0) {
  return fetchJSON<any[]>(`/suggestions?status=${status}&limit=${limit}&offset=${offset}`);
}

export function getSuggestionCounts() {
  return fetchJSON<Record<string, number>>("/suggestions/counts");
}

export function actOnSuggestion(id: number, action: string, rejection_reason = "") {
  return fetchJSON<any>(`/suggestions/${id}/${action}`, {
    method: "POST",
    body: JSON.stringify({ rejection_reason }),
  });
}

export function batchActOnSuggestions(ids: number[], action: string, rejection_reason = "") {
  return fetchJSON<any>(`/suggestions/batch`, {
    method: "POST",
    body: JSON.stringify({ ids, action, rejection_reason }),
  });
}

export function getSuggestionMemory() {
  return fetchJSON<any>("/suggestions/memory");
}

export function getSuggestionUsage(days = 1) {
  return fetchJSON<any>(`/suggestions/usage?days=${days}`);
}

export interface PromoteRequest {
  observation_id: number;
  channel: string;
  use_ai?: boolean;
  fields?: Record<string, unknown>;
  api_key?: string;
}

export interface PromoteResponse {
  channel: string;
  emoji: string;
  headline: string;
  body: string;
  highlights: string[];
  ai_enhanced: boolean;
}

export function promoteGenerate(req: PromoteRequest) {
  return fetchJSON<PromoteResponse>("/promote/generate", {
    method: "POST",
    body: JSON.stringify(req),
  });
}

export interface PromoteConfig {
  enable_ai_promo: boolean;
  enable_meta_publishing: boolean;
  meta_publish_available: boolean;
}

export function getPromoteConfig() {
  return fetchJSON<PromoteConfig>("/promote/config");
}

// ── PropAI Companion ───────────────────────────────────────────

export interface CompanionTeamMember {
  id: number;
  name: string;
  mobile_number: string;
  role: string;
  role_label: string;
  assigned_markets: string[];
  active: boolean;
  waba_identity: string;
  created_at: string;
  updated_at: string;
}

export interface CompanionTeamMemberInput {
  name: string;
  mobile_number: string;
  role: string;
  assigned_markets: string[];
  active: boolean;
  waba_identity: string;
}

export interface CompanionOverview {
  connection_status: string;
  whatsapp_business_number: string;
  connected_team_members: number;
  total_team_members: number;
  last_sync: string;
  messages_today: number;
  ai_requests_today: number;
  pending_conversations: number;
  outbound_messages: number;
  inbound_messages: number;
  webhook_health: string;
  token_status: string;
  knowledge_base_size: Record<string, number>;
  waba: {
    phone_number_id: string;
    has_verify_token: boolean;
    has_access_token: boolean;
  };
}

export interface CompanionConfig {
  whatsapp_business_number: string;
  phone_number_id: string;
  has_access_token: boolean;
  access_token_preview: string;
  has_verify_token: boolean;
  verify_token_preview: string;
}

export interface CompanionConfigInput {
  whatsapp_business_number?: string;
  phone_number_id?: string;
  access_token?: string;
  verify_token?: string;
  clear_access_token?: boolean;
  clear_verify_token?: boolean;
}

export function getCompanionOverview() {
  return fetchJSON<CompanionOverview>("/companion/overview");
}

export function getCompanionConfig() {
  return fetchJSON<CompanionConfig>("/companion/config");
}

export function saveCompanionConfig(config: CompanionConfigInput) {
  return fetchJSON<CompanionConfig>("/companion/config", {
    method: "POST",
    body: JSON.stringify(config),
  });
}

export function getCompanionTeam() {
  return fetchJSON<CompanionTeamMember[]>("/companion/team");
}

export function addCompanionTeamMember(member: CompanionTeamMemberInput) {
  return fetchJSON<CompanionTeamMember>("/companion/team", {
    method: "POST",
    body: JSON.stringify(member),
  });
}

export function updateCompanionTeamMember(id: number, member: CompanionTeamMemberInput) {
  return fetchJSON<CompanionTeamMember>(`/companion/team/${id}`, {
    method: "PATCH",
    body: JSON.stringify(member),
  });
}

export function getCompanionRoles() {
  return fetchJSON<Record<string, { label: string; permissions: string[] }>>("/companion/roles");
}

export function getCompanionTools() {
  return fetchJSON<{ tools: string[] }>("/companion/tools");
}

export function getCompanionConversations() {
  return fetchJSON<any[]>("/companion/conversations");
}

export function getCompanionAudit() {
  return fetchJSON<any[]>("/companion/audit");
}

// ── WhatsApp Audit ──────────────────────────────────────────────

export interface AuditDashboard {
  whatsapp_session: string;
  webhook_status: string;
  groups_discovered: number;
  groups_monitored: number;
  total_groups: number;
  live_groups: number;
  msgs_today: number;
  last_webhook: string;
  webhook_healthy: boolean;
  error_groups: number;
  duplicate_groups: number;
  attention_required: number;
  attention_breakdown: {
    inactive: number;
    duplicate: number;
    unnamed: number;
    error: number;
  };
  inactive_groups: number;
  unnamed_groups: number;
  failed_events: number;
  pending_enrichment: number;
  pending_ai_suggestions: number;
  avg_process_secs: number | null;
  msgs_per_min: number;
  parser_success_rate: number;
  queue_backlog: number;
}

export interface AuditTimelineEvent {
  source: string;
  ts: string;
  subtype: string;
  label: string;
  group_name?: string;
  ref?: number;
}

export interface AuditGroupCard {
  jid: string;
  name: string;
  status: string;
  health: string;
  error: string;
  messages: number;
  last_activity: string;
  observations: number;
  listings: number;
  requirements: number;
  markets_count: number;
  unknown_locations: number;
  coverage: number;
  active_brokers: number;
  duplicate_pct: number;
  parsed: { city?: string; area?: string };
}

export interface AuditCaptureHealth {
  msgs_per_min: number;
  avg_process_secs: number | null;
  parser_success_rate: number;
  last_webhook: string;
  queue_backlog: number;
  pending_enrichment: number;
  pending_ai_suggestions: number;
  total_msgs_today: number;
  total_parsed_today: number;
}

export interface AuditTopContributor {
  group_name: string;
  msg_count: number;
  unique_senders: number;
  last_msg: string;
}

export function getAuditDashboard() {
  return fetchJSON<AuditDashboard>("/audit/dashboard");
}

export function getAuditTimeline(limit = 50) {
  return fetchJSON<AuditTimelineEvent[]>(`/audit/timeline?limit=${limit}`);
}

export function getAuditGroups(q = "", status = "") {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (status) params.set("status", status);
  return fetchJSON<AuditGroupCard[]>(`/audit/groups?${params}`);
}

export function getAuditGroupDetail(jid: string) {
  return fetchJSON<any>(`/audit/groups/${encodeURIComponent(jid)}`);
}

export function getAuditGroupTimeline(jid: string) {
  return fetchJSON<any[]>(`/audit/groups/${encodeURIComponent(jid)}/timeline`);
}

export function getAuditDuplicates() {
  return fetchJSON<any[]>("/audit/duplicates");
}

export function getAuditCaptureHealth() {
  return fetchJSON<AuditCaptureHealth>("/audit/capture-health");
}

export interface AuditLatestRecord {
  id: number | string;
  time: string;
  conversation: string;
  sender: string;
  preview: string;
  stored: boolean;
}

export interface AuditIntelligence {
  network?: Record<string, number | string | boolean>;
  capture?: Record<string, number | string | boolean | AuditLatestRecord[]>;
  search_coverage?: Record<string, number | string>;
  learning?: Record<string, number | string | { term: string; learned_as: string }[]>;
}

export interface AuditSearchEvidence {
  count: number;
  first_seen: string;
  last_seen: string;
  groups: number;
  unique_senders: number;
  top_groups: { name: string; count: number }[];
  recent?: AuditLatestRecord[];
}

export function getAuditIntelligence() {
  return fetchJSON<AuditIntelligence>("/audit/intelligence", undefined, 20000);
}

export function getAuditSearchEvidence(q: string) {
  return fetchJSON<AuditSearchEvidence>(`/audit/search-evidence?q=${encodeURIComponent(q)}`);
}

export function getAuditTopContributors(limit = 10) {
  return fetchJSON<AuditTopContributor[]>(`/audit/top-contributors?limit=${limit}`);
}
