import { supabase } from "./supabase.js";
const AUTH_CODE_TTL_MS = 5 * 60 * 1000;
export async function getOAuthClient(clientId) {
    const { data, error } = await supabase
        .from("mcp_oauth_clients")
        .select("client_id, client_name, redirect_uris, grant_types, response_types, token_endpoint_auth_method, created_at")
        .eq("client_id", clientId)
        .maybeSingle();
    if (error)
        throw new Error(error.message);
    return data;
}
export async function createOAuthClient(client) {
    const { error } = await supabase
        .from("mcp_oauth_clients")
        .upsert(client, { onConflict: "client_id" });
    if (error)
        throw new Error(error.message);
}
export async function saveAuthorizationCode(code) {
    const { error } = await supabase
        .from("mcp_oauth_codes")
        .upsert(code, { onConflict: "code" });
    if (error)
        throw new Error(error.message);
}
export async function getAuthorizationCode(code) {
    const { data, error } = await supabase
        .from("mcp_oauth_codes")
        .select("code, client_id, redirect_uri, code_challenge, code_challenge_method, access_token, refresh_token, expires_in, created_at")
        .eq("code", code)
        .maybeSingle();
    if (error)
        throw new Error(error.message);
    return data;
}
export async function deleteAuthorizationCode(code) {
    const { error } = await supabase
        .from("mcp_oauth_codes")
        .delete()
        .eq("code", code);
    if (error)
        throw new Error(error.message);
}
export async function pruneAuthorizationCodes() {
    const cutoffIso = new Date(Date.now() - AUTH_CODE_TTL_MS).toISOString();
    const { error } = await supabase
        .from("mcp_oauth_codes")
        .delete()
        .lt("created_at", cutoffIso);
    if (error)
        throw new Error(error.message);
}
