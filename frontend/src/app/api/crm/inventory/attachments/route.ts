import { NextRequest } from "next/server";

const API_BASE = (process.env.LAB_API_BASE_URL || "http://localhost:8000").replace(/\/$/, "");

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const headers = new Headers();
    for (const name of ["authorization", "x-tenant-id"]) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    const upstream = await fetch(`${API_BASE}/api/crm/inventory/attachments`, {
      method: "POST",
      headers,
      body: await request.formData(),
      cache: "no-store",
    });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { "Content-Type": upstream.headers.get("content-type") || "application/json" },
    });
  } catch (error) {
    console.error("Private CRM attachment upload proxy failed", error);
    return Response.json(
      { detail: "Private file upload is temporarily unavailable. Please try again." },
      { status: 503 },
    );
  }
}
