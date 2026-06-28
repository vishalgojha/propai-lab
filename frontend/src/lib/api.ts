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
  buildings_known: number;
  landmarks_known: number;
  developers_known: number;
  micro_markets_known: number;
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
