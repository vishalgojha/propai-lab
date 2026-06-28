const BASE = "/api";

async function fetchJSON<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${url}`, {
    headers: { "Content-Type": "application/json", ...init?.headers },
    ...init,
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
  raw_message: string;
  raw_group: string;
  raw_sender: string;
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
  confidence: number;
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
  latest_message: string;
  latest_group: string;
  latest_timestamp: string;
  latest_sender: string;
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

export function getBuildings() {
  return fetchJSON<any[]>("/buildings");
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

export function getBuildingProfile(name: string) {
  return fetchJSON<any>(`/buildings/${encodeURIComponent(name)}`);
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
  sources: string[];
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
  return fetchJSON<ChatResponse>("/ai/chat", {
    method: "POST",
    body: JSON.stringify({ messages, api_key: apiKey, model }),
  });
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

export function getDashboardListings(limit = 20) {
  return fetchJSON<any[]>(`/dashboard/listings?limit=${limit}`);
}

export function getDashboardRequirements(limit = 20) {
  return fetchJSON<any[]>(`/dashboard/requirements?limit=${limit}`);
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

export function getAuditTopContributors(limit = 10) {
  return fetchJSON<AuditTopContributor[]>(`/audit/top-contributors?limit=${limit}`);
}
