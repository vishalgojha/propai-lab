"use client";

export const dynamic = "force-dynamic";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { getSession } from "@/lib/auth";
import { fetchJSON, getCurrentOrg } from "@/lib/api";

type Preview = { label: string; write_access: boolean; scopes: string[]; workspace_id?: string; status?: string; return_url?: string };

const SCOPE_LABELS: Record<string, string> = {
  "raw_messages:read": "Read captured group messages in this account.",
  "raw_messages:dms": "Read private direct messages, subject to this account's separate DM permission.",
  "inventory:read": "Read listings in this account.",
  "requirements:read": "Read buyer requirements in this account.",
  "matches:read": "Read matches in this account.",
  "standing_searches:read": "Read saved searches.",
  "automatch:read": "Read automatic matches.",
  "workspace:attention": "Read account attention items.",
  "followups:read": "Read follow-ups.",
  "inventory:write": "Save private inventory. Sensitive saves still need separate approval.",
  "requirements:write": "Save private requirements. Sensitive saves still need separate approval.",
  "standing_searches:write": "Save searches.",
  "followups:write": "Save follow-ups.",
};

type Stage = "checking" | "ready" | "deciding" | "approved" | "collected" | "denied" | "expired" | "revoked" | "error";

// Collection is not a read test or durable assistant storage. Legacy servers
// may call it connected; this client deliberately does not repeat that claim.
function stageFor(raw?: string): Stage {
  if (raw === "connected" || raw === "consumed" || raw === "collected") return "collected";
  if (raw === "approved" || raw === "approving") return "approved";
  if (raw === "denied" || raw === "expired" || raw === "revoked") return raw;
  if (!raw || raw === "pending") return "ready";
  return "error";
}

export default function ConnectAgentPage() {
  const [stage, setStage] = useState<Stage>("checking");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [workspace, setWorkspace] = useState<{id: string; name?: string} | null>(null);
  const [code, setCode] = useState("");
  const [message, setMessage] = useState("");
  const busy = useRef(false);
  const scopes = [...new Set(preview?.scopes || [])];
  const scopeReviewBlocked = scopes.length === 0 || scopes.some(scope => !SCOPE_LABELS[scope]);
  const returnUrl = preview?.return_url === "https://wa.me/16508702892" ? preview.return_url : null;

  useEffect(() => {
    let active = true;
    const value = (new URLSearchParams(window.location.search).get("code") || "").trim().toUpperCase();
    setCode(value);
    if (!/^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(value)) {
      setStage("error"); setMessage("This approval link is incomplete. Return to your assistant for a new link."); return;
    }
    void (async () => {
      try {
        const session = await getSession();
        if (!session?.access_token) { window.location.href = `/auth/login?next=${encodeURIComponent(`/connect?code=${value}`)}`; return; }
        const [result, org] = await Promise.all([
          fetchJSON<Preview>(`/external/v1/connect/sessions/by-code/${encodeURIComponent(value)}`), getCurrentOrg(),
        ]);
        if (!active) return;
        if (!result.workspace_id || result.workspace_id !== org.id) throw new Error("We could not confirm which account you are allowing. Reopen the approval link.");
        setPreview(result); setWorkspace(org); setStage(stageFor(result.status));
      } catch { if (active) {setStage("error");setMessage("We could not check this approval link and account. Nothing new has been allowed here. Return to your assistant for help.");} }
    })();
    return () => { active = false; };
  }, []);

  async function decide(allow: boolean) {
    if (!code || !workspace || !preview || busy.current || (allow && scopeReviewBlocked)) return;
    busy.current = true; setStage("deciding");
    try {
      await fetchJSON(`/external/v1/connect/sessions/by-code/${encodeURIComponent(code)}/${allow ? "approve" : "deny"}`, {
        method: "POST", body: JSON.stringify({workspace_id: workspace.id}),
      });
      setStage(allow ? "approved" : "denied");
    } catch {setStage("error");setMessage("We could not confirm the result. Do not approve again yet. Return to your assistant to check what happened.");}
    finally {busy.current = false;}
  }

  return <main className="min-h-screen bg-black px-4 py-10 text-white flex items-center justify-center">
    <section aria-label="Assistant connection" className="w-full max-w-md rounded-2xl border border-white/10 bg-zinc-950 p-6">
      <p className="mb-6 text-lg font-bold">PropAI</p>
      <h1 className="text-2xl font-semibold">{stage === "ready" ? "Allow your assistant?" : "Connect my assistant"}</h1>
      {stage === "checking" && <p role="status" className="mt-5 text-sm text-zinc-300">Checking your sign-in and account...</p>}
      {stage === "ready" && preview && workspace && <>
        <p className="mt-3 text-sm text-zinc-300"><strong>{preview.label}</strong> is asking to read information from your PropAI account.</p>
        <div className="mt-5 rounded-xl border border-white/10 p-4 text-sm">
          <p className="text-zinc-400">Account you are allowing</p><p className="mt-1 font-semibold">{workspace.name || "Your PropAI workspace"}</p>
          <p className="mt-3 break-all text-xs text-zinc-400">Account reference: {workspace.id}</p>
        </div>
        <ul className="mt-5 space-y-3 text-sm text-zinc-300">
          {scopes.map(scope => <li key={scope}>{SCOPE_LABELS[scope] || `Unrecognized access: ${scope}`}</li>)}
          {!scopes.includes("raw_messages:dms") && <li>Private direct messages are not included in this new connection.</li>}
          {!scopes.some(scope => scope.endsWith(":write")) && <li>Cannot change your saved records.</li>}
          <li>Cannot send messages. Does not share your groups or add access to other brokers' data.</li>
        </ul>
        {scopeReviewBlocked && <p role="alert" className="mt-4 text-sm text-red-200">We could not fully describe the requested access. Do not allow this request. Return to your assistant for help.</p>}
        <p className="mt-5 text-xs text-zinc-400">Only allow this if you asked this assistant to connect.</p>
        <p className="mt-3 text-xs text-zinc-400">You can remove this assistant's access in PropAI's connection settings.</p>
        <div className="mt-6 flex gap-3"><button disabled={scopeReviewBlocked} style={{opacity: scopeReviewBlocked ? 0.4 : 1}} onClick={() => decide(true)} className="min-h-12 flex-1 rounded-lg bg-emerald-400 px-4 py-3 font-semibold text-black">Allow</button><button onClick={() => decide(false)} className="min-h-12 rounded-lg border border-white/20 px-4 py-3">Not now</button></div>
      </>}
      {stage === "deciding" && <p role="status" className="mt-5 text-sm">Saving your choice...</p>}
      {(stage === "approved" || stage === "collected") && <div role="status" className="mt-5 rounded-xl border border-white/10 p-4 text-sm text-zinc-300">
        <h2 className="font-semibold text-white">Access allowed. Finish in your chat.</h2>
        <p className="mt-3">{stage === "collected" ? "Your assistant has collected the connection details. That alone does not confirm it can read your account." : "Your assistant still needs to collect and check the connection."}</p>
        <p className="mt-3">Return to your assistant and ask it to finish connecting. Wait for its read check before relying on the connection.</p>
        {returnUrl && <a href={returnUrl} style={{color: "#001b13"}} className="mt-5 block min-h-12 rounded-lg bg-emerald-400 px-4 py-3 text-center font-semibold text-black">Return to Instinct</a>}
        <p className="mt-3 text-xs">If the assistant cannot finish, keep this as unfinished. Do not enter another password or repeatedly allow new connections.</p>
      </div>}
      {stage === "denied" && <p role="status" className="mt-5 text-sm">Not allowed. No access was granted by this request.</p>}
      {(stage === "expired" || stage === "revoked") && <p role="status" className="mt-5 text-sm">{stage === "revoked" ? "This assistant's access was removed." : "This approval link has expired."} Return to your assistant if you want a new connection.</p>}
      {stage === "error" && <p role="alert" className="mt-5 rounded-xl border border-red-400/30 p-4 text-sm text-red-200">{message || "This connection could not be checked. Return to your assistant."}</p>}
      <Link href="/workspace/instinct" className="mt-6 inline-block min-h-11 py-3 text-sm text-emerald-300">Back to assistant setup</Link>
    </section>
  </main>;
}
