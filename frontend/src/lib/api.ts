const BASE = "/api";

async function fetchJSON<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${url}`, {
    headers: { "Content-Type": "application/json", ...init?.headers },
    ...init,
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${body}`);
  }
  return res.json();
}

export interface RawMessage {
  id: number;
  group_name: string;
  sender: string;
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

export function getRaw(limit = 50, offset = 0) {
  return fetchJSON<RawMessage[]>(`/raw?limit=${limit}&offset=${offset}`);
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

export function searchMessages(q: string) {
  return fetchJSON<any[]>(`/search?q=${encodeURIComponent(q)}`);
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

export function chatAIChat(
  messages: { role: string; content: string }[],
  apiKey = ""
): Promise<ChatResponse> {
  return fetchJSON<ChatResponse>("/ai/chat", {
    method: "POST",
    body: JSON.stringify({ messages, api_key: apiKey }),
  });
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

export function actOnSuggestion(id: number, action: string) {
  return fetchJSON<any>(`/suggestions/${id}/${action}`, { method: "POST" });
}

export interface PromoteRequest {
  observation_id: number;
  channel: string;
  use_ai?: boolean;
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
