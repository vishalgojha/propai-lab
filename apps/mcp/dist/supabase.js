import { createClient } from "@supabase/supabase-js";
import crypto from "node:crypto";
import dotenv from "dotenv";
import ws from "ws";
dotenv.config();
const supabaseUrl = process.env.SUPABASE_URL || "";
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || "";
const anonKey = process.env.SUPABASE_ANON_KEY || "";
const MCP_CONNECTOR_PROVIDER = "propai_mcp";
const MCP_TOKEN_SECRET_SOURCE = process.env.MCP_TOKEN_ENCRYPTION_SECRET ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_KEY ||
    process.env.JWT_SECRET ||
    "";
function missingClient(name) {
    return new Proxy({}, {
        get() {
            throw new Error(`${name} is not configured. Set SUPABASE_URL and a Supabase API key.`);
        },
    });
}
function buildClient(key, name) {
    if (!supabaseUrl || !key) {
        console.warn(`${name} is not configured. Set SUPABASE_URL and a Supabase API key.`);
        return missingClient(name);
    }
    return createClient(supabaseUrl, key, {
        auth: {
            persistSession: false,
            autoRefreshToken: false,
        },
        realtime: {
            transport: ws,
        },
    });
}
export const supabase = buildClient(serviceKey || anonKey, "PropAI MCP Supabase service client");
export const supabaseAuth = buildClient(anonKey || serviceKey, "PropAI MCP Supabase auth client");
function normalizeEmail(value) {
    return String(value || "").trim().toLowerCase();
}
function isMissingWorkspaceMembershipSchemaError(error) {
    const candidate = error;
    const haystack = [
        candidate?.message,
        candidate?.details,
        candidate?.hint,
    ]
        .map((value) => String(value || "").toLowerCase())
        .join(" ");
    return candidate?.code === "42P01"
        || candidate?.code === "42703"
        || haystack.includes("workspace_members")
        || haystack.includes("schema cache")
        || haystack.includes("does not exist")
        || haystack.includes("updated_at")
        || haystack.includes("joined_at")
        || haystack.includes("last_active_at")
        || haystack.includes("assigned_session_labels")
        || haystack.includes("preferred_session_label");
}
export async function resolveBrokerIdForUser(user) {
    const currentUserId = String(user?.id || "").trim();
    const currentUserEmail = normalizeEmail(user?.email);
    const metadataBrokerId = String(user?.user_metadata?.workspace_owner_id
        || user?.app_metadata?.workspace_owner_id
        || "").trim();
    if (metadataBrokerId) {
        return metadataBrokerId;
    }
    if (!currentUserId) {
        return null;
    }
    try {
        const byUserId = await supabase
            .from("workspace_members")
            .select("workspace_owner_id, status")
            .eq("member_user_id", currentUserId)
            .in("status", ["invited", "active"])
            .order("updated_at", { ascending: false })
            .limit(1)
            .maybeSingle();
        if (byUserId.error) {
            if (!isMissingWorkspaceMembershipSchemaError(byUserId.error)) {
                console.warn("Failed to resolve MCP broker id by user id:", byUserId.error.message);
            }
        }
        else if (byUserId.data?.workspace_owner_id) {
            return String(byUserId.data.workspace_owner_id);
        }
        if (currentUserEmail) {
            const byEmail = await supabase
                .from("workspace_members")
                .select("workspace_owner_id, status")
                .eq("member_email", currentUserEmail)
                .in("status", ["invited", "active"])
                .order("updated_at", { ascending: false })
                .limit(1)
                .maybeSingle();
            if (byEmail.error) {
                if (!isMissingWorkspaceMembershipSchemaError(byEmail.error)) {
                    console.warn("Failed to resolve MCP broker id by email:", byEmail.error.message);
                }
            }
            else if (byEmail.data?.workspace_owner_id) {
                return String(byEmail.data.workspace_owner_id);
            }
        }
    }
    catch (error) {
        console.warn("Unexpected error resolving MCP broker id:", error instanceof Error ? error.message : error);
    }
    return currentUserId;
}
function hashMcpConnectorToken(token) {
    return `sha256:${crypto.createHash("sha256").update(token).digest("hex")}`;
}
function getMcpTokenSecret() {
    if (!MCP_TOKEN_SECRET_SOURCE) {
        throw new Error("MCP token encryption secret is not configured");
    }
    return crypto.createHash("sha256").update(MCP_TOKEN_SECRET_SOURCE).digest();
}
function decryptMcpConnectorToken(value) {
    if (!value.startsWith("enc:")) {
        return null;
    }
    const payload = value.slice(4);
    const [ivPart, tagPart, encryptedPart] = payload.split(".");
    if (!ivPart || !tagPart || !encryptedPart) {
        throw new Error("Stored MCP token is malformed");
    }
    const decipher = crypto.createDecipheriv("aes-256-gcm", getMcpTokenSecret(), Buffer.from(ivPart, "base64url"));
    decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
    const decrypted = Buffer.concat([
        decipher.update(Buffer.from(encryptedPart, "base64url")),
        decipher.final(),
    ]);
    return decrypted.toString("utf8");
}
async function verifyStaticConnectorToken(token) {
    const { data: storedKeys, error: keyError } = await supabase
        .from("api_keys")
        .select("tenant_id, key")
        .eq("provider", MCP_CONNECTOR_PROVIDER)
        .limit(1000);
    if (keyError || !storedKeys?.length) {
        throw new Error(keyError?.message || "Invalid token");
    }
    const tokenDigest = hashMcpConnectorToken(token);
    const storedKey = storedKeys.find((candidate) => {
        if (candidate.key === tokenDigest) {
            return true;
        }
        if (typeof candidate.key !== "string" || !candidate.key.startsWith("enc:")) {
            return false;
        }
        try {
            const decryptedToken = decryptMcpConnectorToken(candidate.key);
            return decryptedToken === token;
        }
        catch {
            return false;
        }
    });
    if (!storedKey?.tenant_id) {
        throw new Error("Invalid token");
    }
    const { data, error } = await supabase.auth.admin.getUserById(storedKey.tenant_id);
    if (error || !data.user) {
        throw new Error(error?.message || "Invalid token");
    }
    return {
        ...data.user,
        broker_id: data.user.id,
    };
}
export async function verifyPropAIToken(token) {
    const { data, error } = await supabase.auth.getUser(token);
    if (!error && data.user) {
        return {
            ...data.user,
            broker_id: data.user.id,
        };
    }
    const appSession = verifyAppSessionToken(token);
    if (appSession) {
        return {
            id: appSession.sub,
            broker_id: appSession.sub,
            email: appSession.email,
            aud: "authenticated",
            role: "authenticated",
            app_metadata: { provider: "propai" },
            user_metadata: {
                full_name: appSession.full_name,
                phone: appSession.phone,
                app_role: appSession.app_role,
            },
            created_at: new Date().toISOString(),
        };
    }
    return verifyStaticConnectorToken(token);
}
function base64UrlDecode(input) {
    const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    return Buffer.from(padded, "base64").toString("utf8");
}
function getJwtSecret() {
    return process.env.JWT_SECRET || process.env.SUPABASE_JWT_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || "";
}
function verifyAppSessionToken(token) {
    const parts = token.split(".");
    if (parts.length !== 3)
        return null;
    const [encodedHeader, encodedPayload, signature] = parts;
    const secret = getJwtSecret();
    if (!secret)
        return null;
    const data = `${encodedHeader}.${encodedPayload}`;
    const expectedSignature = crypto
        .createHmac("sha256", secret)
        .update(data)
        .digest("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/g, "");
    if (signature.length !== expectedSignature.length)
        return null;
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature)))
        return null;
    try {
        const payload = JSON.parse(base64UrlDecode(encodedPayload));
        if (!payload || payload.typ !== "propai-app-session")
            return null;
        const now = Math.floor(Date.now() / 1000);
        if (!Number.isFinite(payload.exp) || payload.exp <= now)
            return null;
        return payload;
    }
    catch {
        return null;
    }
}
