"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertCircle, CheckCircle, Eye, EyeOff, Loader2, Lock } from "lucide-react";
import { getSupabase, updatePassword } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default function ResetPasswordPage() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [show, setShow] = useState(false);
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const prepare = async () => {
      try {
        const params = new URLSearchParams(window.location.search);
        const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
        const code = params.get("code");
        const accessToken = hash.get("access_token");
        const refreshToken = hash.get("refresh_token");
        const auth = getSupabase();
        if (code) {
          const result = await auth.auth.exchangeCodeForSession(code);
          if (result.error) throw result.error;
        } else if (accessToken && refreshToken) {
          const result = await auth.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
          if (result.error) throw result.error;
        }
        const { data } = await auth.auth.getSession();
        if (!data.session) throw new Error("This reset link is invalid or has expired.");
        setReady(true);
        window.history.replaceState({}, document.title, window.location.pathname);
      } catch (reason: unknown) {
        setError(reason instanceof Error ? reason.message : "This reset link is invalid or has expired.");
      } finally {
        setLoading(false);
      }
    };
    void prepare();
  }, []);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    if (password.length < 8) return setError("Use at least 8 characters.");
    if (password !== confirm) return setError("Passwords do not match.");
    setLoading(true);
    try {
      await updatePassword(password);
      setMessage("Password updated. Redirecting to your workspace…");
      setTimeout(() => router.replace("/"), 1200);
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : "Could not update your password.");
      setLoading(false);
    }
  };

  return <main className="flex min-h-dvh items-center justify-center bg-[var(--background)] px-4 text-[var(--text-primary)]">
    <section className="w-full max-w-md rounded-[14px] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-7">
      <h1 className="text-2xl font-bold">Set a new password</h1>
      <p className="mt-2 text-sm text-[var(--text-secondary)]">Choose a new password for your PropAI workspace.</p>
      {loading && !ready ? <div className="mt-8 flex items-center gap-2 text-sm text-[var(--text-secondary)]"><Loader2 className="h-4 w-4 animate-spin" />Checking reset link…</div> : ready ? <form onSubmit={submit} className="mt-6 space-y-4">
        <label className="block text-[11px] font-semibold uppercase tracking-wider text-[var(--text-secondary)]">New password
          <div className="relative mt-1"><Lock className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-secondary)]" /><input required minLength={8} type={show ? "text" : "password"} value={password} onChange={(e) => setPassword(e.target.value)} className="w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-base)] py-2.5 pl-10 pr-12 text-sm outline-none focus:border-[var(--accent-primary)]" /></div>
        </label>
        <label className="block text-[11px] font-semibold uppercase tracking-wider text-[var(--text-secondary)]">Confirm password
          <input required minLength={8} type={show ? "text" : "password"} value={confirm} onChange={(e) => setConfirm(e.target.value)} className="mt-1 w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-base)] px-4 py-2.5 text-sm outline-none focus:border-[var(--accent-primary)]" />
        </label>
        <button type="button" onClick={() => setShow(!show)} className="text-xs text-[var(--text-secondary)]">{show ? <EyeOff className="mr-1 inline h-3.5 w-3.5" /> : <Eye className="mr-1 inline h-3.5 w-3.5" />} {show ? "Hide passwords" : "Show passwords"}</button>
        <button disabled={loading} className="flex min-h-[48px] w-full items-center justify-center gap-2 rounded-lg bg-[var(--accent-primary)] px-4 py-2.5 text-sm font-bold text-[#FAF7F0] disabled:opacity-50">{loading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Update password"}</button>
      </form> : null}
      {error && <div className="mt-5 flex gap-2 rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-700"><AlertCircle className="h-4 w-4 shrink-0" />{error}</div>}
      {message && <div className="mt-5 flex gap-2 rounded-lg border border-emerald-500/20 bg-emerald-500/10 p-3 text-sm text-emerald-700"><CheckCircle className="h-4 w-4 shrink-0" />{message}</div>}
      <Link href="/auth/login" className="mt-6 block text-center text-sm text-[var(--accent-primary)]">Back to sign in</Link>
    </section>
  </main>;
}
