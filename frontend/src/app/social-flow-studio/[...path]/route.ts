import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

const SDK_BASE = (process.env.SOCIAL_FLOW_SDK_URL || "").replace(/\/$/, "");
const SDK_KEY = process.env.SOCIAL_FLOW_SDK_API_KEY || "";

async function authorized(request: NextRequest) {
  const authorization = request.headers.get("authorization") || "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!token) return false;
  const { data, error } = await getSupabaseAdmin().auth.getUser(token);
  return !error && Boolean(data.user);
}

function patchStudioScript(source: string) {
  return source
    .replace(
      'var baseUrl = (window.location.protocol + "//" + window.location.host).replace(/\\/$/, "");',
      'var baseUrl = window.location.origin + "/social-flow-studio";',
    )
    .replace(
      'headers: options.body ? { "Content-Type": "application/json" } : undefined,',
      'headers: Object.assign(options.body ? { "Content-Type": "application/json" } : {}, (window.localStorage.getItem("propai_social_flow_token") ? { Authorization: "Bearer " + window.localStorage.getItem("propai_social_flow_token") } : {})),',
    );
}

function patchStudioHtml(source: string) {
  const theme = `
    <style id="propai-studio-theme">
      :root { color-scheme: dark; }
      html, body { background: #090b0f !important; color: #f4f4f5 !important; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important; }
      body { min-width: 320px; }
      header, nav, [class*="topbar"], [class*="header"] { background: #0d1117 !important; border-color: rgba(255,255,255,.10) !important; }
      main, [class*="container"], [class*="shell"], [class*="layout"] { width: 100% !important; max-width: none !important; }
      section, article, [class*="card"], [class*="panel"] { background: #11151c !important; border-color: rgba(255,255,255,.10) !important; box-shadow: none !important; }
      input, textarea, select { background: #0d1117 !important; color: #f4f4f5 !important; border-color: rgba(255,255,255,.14) !important; }
      input:focus, textarea:focus, select:focus { border-color: rgba(62,232,138,.65) !important; outline: 2px solid rgba(62,232,138,.12) !important; }
      button[type="submit"], button.primary, button[class*="primary"], .btn-primary { background: #3ee88a !important; color: #07110b !important; border-color: #3ee88a !important; }
      button[type="submit"]:hover, button.primary:hover, button[class*="primary"]:hover, .btn-primary:hover { background: #35d47c !important; }
      a { color: #3ee88a; }
      [class*="badge"], [class*="pill"] { border-color: rgba(62,232,138,.30) !important; }
    </style>
  `;
  return source.includes("</head>") ? source.replace("</head>", `${theme}</head>`) : `${theme}${source}`;
}

async function proxy(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const path = (await context.params).path || [];
  const isApi = path[0] === "api";
  if (isApi && !(await authorized(request))) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }
  if (!SDK_BASE) return NextResponse.json({ error: "Social Flow is not configured" }, { status: 503 });

  const target = `${SDK_BASE}/${path.join("/")}${new URL(request.url).search}`;
  const headers = new Headers({ Accept: isApi ? "application/json" : "*/*" });
  if (SDK_KEY) headers.set("X-Gateway-Key", SDK_KEY);
  const contentType = request.headers.get("content-type");
  if (contentType) headers.set("Content-Type", contentType);
  const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
  const response = await fetch(target, { method: request.method, headers, body, cache: "no-store" });
  const responseContentType = response.headers.get("content-type") || "application/octet-stream";

  if (!isApi && path.at(-1) === "app.js" && responseContentType.includes("javascript")) {
    return new NextResponse(patchStudioScript(await response.text()), {
      status: response.status,
      headers: { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
  if (!isApi && responseContentType.includes("text/html")) {
    return new NextResponse(patchStudioHtml(await response.text()), {
      status: response.status,
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
  return new NextResponse(response.body, {
    status: response.status,
    headers: { "Content-Type": responseContentType, "Cache-Control": "no-store" },
  });
}

export async function GET(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  return proxy(request, context);
}

export async function POST(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  return proxy(request, context);
}
