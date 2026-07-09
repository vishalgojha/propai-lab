import crypto from "node:crypto";
import type { Request, Response } from "express";
import {
  createOAuthClient,
  deleteAuthorizationCode,
  getAuthorizationCode,
  getOAuthClient,
  pruneAuthorizationCodes,
  saveAuthorizationCode,
} from "./oauthStore.js";
import { supabaseAuth } from "./supabase.js";

// Device code flow constants
const DEVICE_CODE_EXPIRY_SECONDS = 900; // 15 minutes
const DEVICE_CODE_INTERVAL_SECONDS = 5; // polling interval
const DEVICE_CODE_LENGTH = 4;
const DEVICE_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const DEVICE_CODE_PREFIX = "PROP-";

function publicUrl(req: Request) {
  return process.env.MCP_SERVER_URL || `${req.protocol}://${req.get("host")}`;
}

// Generate a device code similar to activation codes
function generateDeviceCode(): string {
  let result = '';
  for (let i = 0; i < DEVICE_CODE_LENGTH; i++) {
    result += DEVICE_CODE_CHARS.charAt(Math.floor(Math.random() * DEVICE_CODE_CHARS.length));
  }
  return `${DEVICE_CODE_PREFIX}${result}`;
}

// In-memory store for device codes (in production, use Redis or database)
interface DeviceCodeRecord {
  device_code: string;
  user_code: string;
  client_id: string;
  expires_at: string;
  interval: number;
  // Optional fields for when authorized
  user_id?: string;
  phone_number?: string;
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  authorized_at?: string;
}

// Simple in-memory store - replace with Redis/DB in production
const deviceCodeStore = new Map<string, DeviceCodeRecord>();

function storeDeviceCode(record: DeviceCodeRecord) {
  deviceCodeStore.set(record.device_code, {
    ...record,
    expires_at: new Date(Date.now() + DEVICE_CODE_EXPIRY_SECONDS * 1000).toISOString(),
  });
}

function getDeviceCode(device_code: string): DeviceCodeRecord | undefined {
  const record = deviceCodeStore.get(device_code);
  if (!record) return undefined;
  
  // Check if expired
  if (new Date(record.expires_at) < new Date()) {
    deviceCodeStore.delete(device_code);
    return undefined;
  }
  
  return record;
}

function deleteDeviceCode(device_code: string) {
  deviceCodeStore.delete(device_code);
}

function cleanExpiredDeviceCodes() {
  const now = new Date();
  for (const [device_code, record] of deviceCodeStore.entries()) {
    if (new Date(record.expires_at) < now) {
      deviceCodeStore.delete(device_code);
    }
  }
}

function resourceMetadataUrl(req: Request) {
  return `${publicUrl(req)}/.well-known/oauth-protected-resource`;
}

// POST /token - device code polling endpoint
export async function handleDeviceTokenRequest(req: Request, res: Response) {
  const grantType = String(req.body?.grant_type || "");
  const deviceCode = String(req.body?.device_code || "");

  if (grantType !== "urn:ietf:params:oauth:grant-type:device_code") {
    return res.status(400).json({
      error: "unsupported_grant_type",
      error_description: `Unsupported grant type: ${grantType}`,
    });
  }

  if (!deviceCode) {
    return res.status(400).json({
      error: "invalid_request",
      error_description: "device_code is required",
    });
  }

  // Get device code record
  const deviceCodeRecord = getDeviceCode(deviceCode);
  if (!deviceCodeRecord) {
    return res.status(400).json({
      error: "invalid_grant",
      error_description: "Device code is expired or invalid",
    });
  }

  // Check if device code has been authorized (user completed WhatsApp flow)
  if (deviceCodeRecord.user_id && deviceCodeRecord.access_token) {
    // Clean up used device code
    deleteDeviceCode(deviceCode);

    return res.json({
      access_token: deviceCodeRecord.access_token,
      refresh_token: deviceCodeRecord.refresh_token,
      token_type: "bearer",
      expires_in: deviceCodeRecord.expires_in,
    });
  }

  // Check if expired
  if (new Date(deviceCodeRecord.expires_at) < new Date()) {
    deleteDeviceCode(deviceCode);
    return res.status(400).json({
      error: "expired_token",
      error_description: "Device code has expired",
    });
  }

  // Still pending - user hasn't completed WhatsApp verification yet
  return res.status(400).json({
    error: "authorization_pending",
    error_description: "Authorization request is still pending",
    interval: deviceCodeRecord.interval,
  });
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function validateRedirectUri(clientId: string, redirectUri: string) {
  const client = await getOAuthClient(clientId);
  if (!client) return true;
  return client.redirect_uris.includes(redirectUri);
}

function sha256Base64Url(value: string) {
  return crypto.createHash("sha256").update(value).digest("base64url");
}

function renderAuthorizePage(_params: Record<string, string>, error?: string) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>PropAI MCP Authorization</title>
  <style>
    body { font-family: Arial, sans-serif; background: #081018; color: #fff; margin: 0; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .wrap { max-width: 420px; width: 100%; padding: 24px; background: #101923; border: 1px solid #223243; border-radius: 16px; text-align: center; }
    h1 { margin: 0 0 8px; font-size: 20px; }
    p { color: ${error ? "#ff9b9b" : "#9eb0c1"}; line-height: 1.5; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>PropAI MCP</h1>
    <p>${error ? escapeHtml(error) : "Email login is no longer supported. Use the PropAI App to authorize."}</p>
  </div>
</body>
</html>`;
}

export function oauthAuthorizationServerMetadata(req: Request, res: Response) {
  const issuer = publicUrl(req);
  return res.json({
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: ["mcp"],
  });
}

export function oauthProtectedResourceMetadata(req: Request, res: Response) {
  const issuer = publicUrl(req);
  return res.json({
    resource: `${issuer}/mcp`,
    authorization_servers: [issuer],
    bearer_methods_supported: ["header"],
  });
}

export async function oauthAuthorizeGetHandler(req: Request, res: Response) {
  const responseType = String(req.query.response_type || "code");
  const clientId = String(req.query.client_id || "");
  const redirectUri = String(req.query.redirect_uri || "");
  const state = String(req.query.state || "");
  const codeChallenge = String(req.query.code_challenge || "");
  const codeChallengeMethod = String(req.query.code_challenge_method || "S256");

  if (responseType !== "code" || !clientId || !redirectUri || !codeChallenge) {
    return res.status(400).type("html").send(renderErrorPage("Invalid OAuth authorization request"));
  }

  if (!(await validateRedirectUri(clientId, redirectUri))) {
    return res.status(400).type("html").send(renderErrorPage("Redirect URI is not allowed for this client"));
  }

  const deviceCode = generateDeviceCode();
  const userCode = deviceCode;

  const deviceCodeRecord: DeviceCodeRecord = {
    device_code: deviceCode,
    user_code: userCode,
    client_id: clientId,
    expires_at: new Date(Date.now() + DEVICE_CODE_EXPIRY_SECONDS * 1000).toISOString(),
    interval: DEVICE_CODE_INTERVAL_SECONDS,
  };

  storeDeviceCode(deviceCodeRecord);

  res.type("html").send(renderDeviceCodePage({
    userCode,
    deviceCode,
    verificationUri: "https://app.propai.live/mcp-authorize",
    verificationUriComplete: `https://app.propai.live/mcp-authorize?user_code=${userCode}`,
    expiresIn: DEVICE_CODE_EXPIRY_SECONDS,
  }));
}

function renderErrorPage(message: string) {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>PropAI MCP</title>
<style>
body{font-family:Arial,sans-serif;background:#081018;color:#fff;margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh}
.wrap{max-width:420px;padding:24px;background:#101923;border:1px solid #223243;border-radius:16px;text-align:center}
h1{font-size:20px;margin:0 0 8px}p{color:#ff9b9b;line-height:1.5}
</style>
</head>
<body><div class="wrap"><h1>PropAI MCP</h1><p>${escapeHtml(message)}</p></div></body>
</html>`;
}

function renderDeviceCodePage(opts: {
  userCode: string;
  deviceCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
}) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Authorize PropAI MCP</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;background:#050b12;color:#e8edf2;line-height:1.5}
    .page{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
    .card{max-width:440px;width:100%;background:#0d1622;border:1px solid #1e2d3d;border-radius:20px;padding:32px}
    .logo{font-size:13px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#3EE88A;margin-bottom:4px}
    h1{font-size:22px;font-weight:700;margin-bottom:6px}
    .sub{color:#8ea4b9;font-size:14px;margin-bottom:24px}
    .code-box{background:#09111c;border:1px solid #253544;border-radius:14px;padding:20px;text-align:center;margin-bottom:24px}
    .code-box .label{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.12em;color:#6a8097;margin-bottom:8px}
    .code-box .code{font-size:32px;font-weight:800;letter-spacing:0.15em;font-family:'SF Mono','Fira Code','Courier New',monospace;color:#fff;word-break:break-all}
    .code-box .hint{font-size:12px;color:#5a7087;margin-top:8px}
    .btn-group{display:flex;flex-direction:column;gap:10px;margin-bottom:20px}
    .btn{display:flex;align-items:center;justify-content:center;gap:8px;padding:14px 20px;border-radius:12px;font-size:14px;font-weight:700;border:0;cursor:pointer;text-decoration:none;transition:opacity 0.15s}
    .btn:hover{opacity:0.9}
    .btn-app{background:#3EE88A;color:#04120a}
    .btn-app:active{transform:scale(0.98)}
    .error{color:#ff7b7b;font-size:13px;margin-top:10px;padding:10px 14px;background:rgba(255,50,50,0.08);border-radius:8px;display:none}
  </style>
</head>
<body>
  <div class="page">
    <div class="card">
      <div class="logo">PropAI Pulse</div>
      <h1>Connect MCP Server</h1>
      <p class="sub">Authorize this device to use PropAI tools from your IDE or MCP client.</p>

      <div class="code-box">
        <div class="label">Your device code</div>
        <div class="code">${escapeHtml(opts.userCode)}</div>
        <div class="hint">Code expires in ${Math.floor(opts.expiresIn / 60)} minutes</div>
      </div>

      <div class="btn-group">
        <a href="${escapeHtml(opts.verificationUriComplete)}" target="_blank" class="btn btn-app" onclick="document.getElementById('pollMsg').style.display='block'">
          Authorize with PropAI App
        </a>
      </div>
      <p id="pollMsg" style="display:none;font-size:12px;color:#8ea4b9;text-align:center;margin-bottom:16px">
        Waiting for authorization… Your MCP client will connect automatically once approved.
      </p>

    </div>
  </div>
</body>
</html>`;
}

export async function oauthAuthorizePostHandler(req: Request, res: Response) {
  const {
    email,
    password,
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: codeChallengeMethod = "S256",
  } = req.body ?? {};

  if (!email || !password || !clientId || !redirectUri || !codeChallenge) {
    return res.status(400).send("Missing required OAuth authorization fields");
  }

  if (!(await validateRedirectUri(String(clientId), String(redirectUri)))) {
    return res.status(400).send("Redirect URI is not allowed for this client");
  }

  const { data, error } = await supabaseAuth.auth.signInWithPassword({
    email: String(email).trim().toLowerCase(),
    password: String(password),
  });

  if (error || !data.session) {
    return res
      .status(401)
      .setHeader("Content-Type", "text/html; charset=utf-8")
      .send(renderAuthorizePage({
        response_type: "code",
        client_id: String(clientId),
        redirect_uri: String(redirectUri),
        state: String(state || ""),
        code_challenge: String(codeChallenge),
        code_challenge_method: String(codeChallengeMethod || "S256"),
      }, error?.message || "Invalid credentials"));
  }

  await pruneAuthorizationCodes();

  const existingClient = await getOAuthClient(String(clientId));
  if (!existingClient) {
    await createOAuthClient({
      client_id: String(clientId),
      client_name: String(req.body?.client_name || "PropAI MCP Client"),
      redirect_uris: [String(redirectUri)],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      created_at: new Date().toISOString(),
    });
  }

  const code = crypto.randomBytes(32).toString("base64url");
  await saveAuthorizationCode({
    code,
    client_id: String(clientId),
    redirect_uri: String(redirectUri),
    code_challenge: String(codeChallenge),
    code_challenge_method: String(codeChallengeMethod || "S256"),
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token || null,
    expires_in: data.session.expires_in || 86400,
    created_at: new Date().toISOString(),
  });

  const target = new URL(String(redirectUri));
  target.searchParams.set("code", code);
  if (state) {
    target.searchParams.set("state", String(state));
  }

  return res.redirect(target.toString());
}

export async function oauthRegisterHandler(req: Request, res: Response) {
  const redirectUris = Array.isArray(req.body?.redirect_uris)
    ? req.body.redirect_uris.map((entry: unknown) => String(entry))
    : [];

  if (!redirectUris.length) {
    return res.status(400).json({
      error: "invalid_client_metadata",
      error_description: "redirect_uris is required",
    });
  }

  const clientId = crypto.randomUUID();
  const client = {
    client_id: clientId,
    client_name: String(req.body?.client_name || "PropAI MCP Client"),
    redirect_uris: redirectUris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none" as const,
    created_at: new Date().toISOString(),
  };
  await createOAuthClient(client);

  return res.status(201).json({
    client_id: client.client_id,
    client_id_issued_at: Math.floor(new Date(client.created_at).getTime() / 1000),
    client_name: client.client_name,
    redirect_uris: client.redirect_uris,
    grant_types: client.grant_types,
    response_types: client.response_types,
    token_endpoint_auth_method: client.token_endpoint_auth_method,
  });
}

export async function oauthTokenHandler(req: Request, res: Response) {
  const grantType = String(req.body?.grant_type || "");

  // Backward-compatible direct credential exchange.
  if (!grantType) {
    const { email, password } = req.body ?? {};

    if (!email || !password) {
      return res.status(400).json({
        error: "invalid_request",
        error_description: "email and password are required",
      });
    }

    const { data, error } = await supabaseAuth.auth.signInWithPassword({
      email: String(email).trim().toLowerCase(),
      password: String(password),
    });

    if (error || !data.session) {
      return res.status(401).json({
        error: "invalid_grant",
        error_description: error?.message || "Invalid credentials",
      });
    }

    return res.json({
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      token_type: "bearer",
      expires_in: data.session.expires_in || 86400,
    });
  }

  if (grantType === "authorization_code") {
    await pruneAuthorizationCodes();
    const code = String(req.body?.code || "");
    const clientId = String(req.body?.client_id || "");
    const redirectUri = String(req.body?.redirect_uri || "");
    const codeVerifier = String(req.body?.code_verifier || "");

    const record = await getAuthorizationCode(code);
    if (!record) {
      return res.status(400).json({
        error: "invalid_grant",
        error_description: "Authorization code is invalid or expired",
      });
    }

    if (record.client_id !== clientId || record.redirect_uri !== redirectUri) {
      return res.status(400).json({
        error: "invalid_grant",
        error_description: "Authorization code does not match client or redirect URI",
      });
    }

    if (record.code_challenge_method !== "S256" || sha256Base64Url(codeVerifier) !== record.code_challenge) {
      return res.status(400).json({
        error: "invalid_grant",
        error_description: "PKCE verification failed",
      });
    }

    await deleteAuthorizationCode(code);
    return res.json({
      access_token: record.access_token,
      refresh_token: record.refresh_token,
      token_type: "bearer",
      expires_in: record.expires_in,
    });
  }

  if (grantType === "refresh_token") {
    const refreshToken = String(req.body?.refresh_token || "");
    if (!refreshToken) {
      return res.status(400).json({
        error: "invalid_request",
        error_description: "refresh_token is required",
      });
    }

    const { data, error } = await supabaseAuth.auth.refreshSession({
      refresh_token: refreshToken,
    });

    if (error || !data.session) {
      return res.status(401).json({
        error: "invalid_grant",
        error_description: error?.message || "Refresh token is invalid",
      });
    }

    return res.json({
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      token_type: "bearer",
      expires_in: data.session.expires_in || 86400,
    });
  }

  return res.status(400).json({
    error: "unsupported_grant_type",
    error_description: `Unsupported grant type: ${grantType}`,
  });
}

export async function deviceAuthorizeHandler(req: Request, res: Response) {
  const userCode = String(req.body?.user_code || "").trim().toUpperCase();
  const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();

  if (!userCode || !token) {
    return res.status(400).json({ error: "user_code and Authorization header required" });
  }

  const { verifyPropAIToken } = await import("./supabase.js");
  const user = await verifyPropAIToken(token).catch(() => null);
  if (!user?.id) {
    return res.status(401).json({ error: "Invalid or expired authorization token" });
  }

  for (const [, record] of deviceCodeStore) {
    if (record.user_code === userCode && new Date(record.expires_at) > new Date()) {
      record.user_id = user.id;
      record.access_token = token;
      record.refresh_token = token;
      record.expires_in = 86400;
      record.authorized_at = new Date().toISOString();
      return res.json({ success: true, message: "Device authorized" });
    }
  }

  return res.status(404).json({ error: "Device code not found or expired" });
}

export function setMcpUnauthorizedHeaders(req: Request, res: Response) {
  res.setHeader("WWW-Authenticate", `Bearer resource_metadata=\"${resourceMetadataUrl(req)}\"`);
}
