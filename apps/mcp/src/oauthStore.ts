import { supabase } from "./supabase.js";

export type StoredOAuthClient = {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: "none";
  created_at: string;
};

export type StoredAuthorizationCode = {
  code: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: string;
  access_token: string;
  refresh_token: string | null;
  expires_in: number;
  created_at: string;
};

const AUTH_CODE_TTL_MS = 5 * 60 * 1000;

export async function getOAuthClient(clientId: string) {
  const { data, error } = await supabase
    .from("mcp_oauth_clients")
    .select("client_id, client_name, redirect_uris, grant_types, response_types, token_endpoint_auth_method, created_at")
    .eq("client_id", clientId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data as StoredOAuthClient | null;
}

export async function createOAuthClient(client: StoredOAuthClient) {
  const { error } = await supabase
    .from("mcp_oauth_clients")
    .upsert(client, { onConflict: "client_id" });

  if (error) throw new Error(error.message);
}

export async function saveAuthorizationCode(code: StoredAuthorizationCode) {
  const { error } = await supabase
    .from("mcp_oauth_codes")
    .upsert(code, { onConflict: "code" });

  if (error) throw new Error(error.message);
}

export async function getAuthorizationCode(code: string) {
  const { data, error } = await supabase
    .from("mcp_oauth_codes")
    .select("code, client_id, redirect_uri, code_challenge, code_challenge_method, access_token, refresh_token, expires_in, created_at")
    .eq("code", code)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data as StoredAuthorizationCode | null;
}

export async function deleteAuthorizationCode(code: string) {
  const { error } = await supabase
    .from("mcp_oauth_codes")
    .delete()
    .eq("code", code);

  if (error) throw new Error(error.message);
}

export async function pruneAuthorizationCodes() {
  const cutoffIso = new Date(Date.now() - AUTH_CODE_TTL_MS).toISOString();
  const { error } = await supabase
    .from("mcp_oauth_codes")
    .delete()
    .lt("created_at", cutoffIso);

  if (error) throw new Error(error.message);
}
