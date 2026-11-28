"use client";

import { useState } from "react";

const MCP_BASE = process.env.NEXT_PUBLIC_MCP_URL || "https://mcp.propai.live";

export default function ClientSignupForm() {
  const [form, setForm] = useState({ full_name: "", phone: "", email: "", password: "" });
  const [state, setState] = useState<"idle" | "busy" | "done">("idle");
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setState("busy");
    try {
      const res = await fetch(`${MCP_BASE}/client/signup`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Could not create the account.");
      setState("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the account.");
      setState("idle");
    }
  }

  if (state === "done") {
    return (
      <p className="rounded-xl border border-green-400/30 p-4 text-green-300" role="status">
        Check your email to confirm your account. Then add the PropAI connector to your assistant and sign in with
        these details when it asks.
      </p>
    );
  }

  const input =
    "w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-white placeholder-zinc-500";
  return (
    <form onSubmit={submit} className="space-y-3">
      <input className={input} placeholder="Your name" required value={form.full_name}
        onChange={(e) => setForm({ ...form, full_name: e.target.value })} autoComplete="name" />
      <input className={input} placeholder="WhatsApp number with country code" required value={form.phone}
        onChange={(e) => setForm({ ...form, phone: e.target.value })} autoComplete="tel" inputMode="tel" />
      <input className={input} type="email" placeholder="Email" required value={form.email}
        onChange={(e) => setForm({ ...form, email: e.target.value })} autoComplete="email" />
      <input className={input} type="password" placeholder="Password (8+ characters)" required minLength={8}
        value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} autoComplete="new-password" />
      {error && <p className="text-sm text-red-400" role="alert">{error}</p>}
      <button type="submit" disabled={state === "busy"}
        className="rounded-lg bg-green-400 px-4 py-2 font-semibold text-black disabled:opacity-60">
        {state === "busy" ? "Creating account..." : "Create client login"}
      </button>
    </form>
  );
}
