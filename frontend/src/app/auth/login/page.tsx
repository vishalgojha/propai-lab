"use client";

export const dynamic = 'force-dynamic';

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Mail, Lock, Eye, EyeOff, ArrowRight, AlertCircle, Loader2, CheckCircle2 } from "lucide-react";
import { signInWithEmail, signInWithMagicLink, getSession } from "@/lib/auth";

const AUTH_NEXT_KEY = "propai_auth_next";

function LoginContent() {
  const router = useRouter();
  const [next] = useState(() => {
    if (typeof window === "undefined") return "/";
    return new URLSearchParams(window.location.search).get("next") || "/";
  });

  const [mode, setMode] = useState<"email" | "magic">("email");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      if (mode === "email") {
        await signInWithEmail(email, password);
      } else {
        localStorage.setItem(AUTH_NEXT_KEY, next);
        await signInWithMagicLink(email, `${window.location.origin}/auth/callback`);
        alert("Magic link sent! Check your email.");
        return;
      }

      router.push(next);
      router.refresh();
    } catch (error: unknown) {
      setError(error instanceof Error ? error.message : "Sign in failed");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    getSession().then((session) => {
      if (session) router.push(next);
    });
  }, [next, router]);

  return (
    <div className="min-h-dvh bg-[var(--background)] px-4 py-8 text-[var(--text-primary)] sm:px-8 lg:px-12 lg:py-12">
      <div className="mx-auto grid min-h-[calc(100dvh-6rem)] w-full max-w-6xl items-center gap-12 lg:grid-cols-[minmax(0,0.9fr)_minmax(26rem,0.75fr)] lg:gap-20">
        <section className="hidden lg:block">
          <Link href="/" className="inline-flex items-center gap-3">
            <img src="/propai-logo.svg" alt="" aria-hidden="true" className="h-12 w-12" />
            <span className="text-xl font-bold tracking-tight">Prop<span className="text-[var(--accent-primary)]">AI</span></span>
          </Link>
          <div className="mt-20 max-w-xl">
            <p className="text-xs font-bold uppercase tracking-[0.22em] text-[var(--accent-forest)]">Broker operating system</p>
            <h1 className="mt-4 max-w-lg text-5xl font-semibold leading-[1.03] tracking-[-0.04em] text-[var(--text-primary)]">
              Turn broker conversations into your next deal.
            </h1>
            <p className="mt-6 max-w-lg text-lg leading-8 text-[var(--text-secondary)]">
              PropAI keeps your live WhatsApp market searchable, fresh, and connected to the people who shared it.
            </p>
            <div className="mt-10 grid gap-4 text-sm text-[var(--text-secondary)]">
              {["Find the right property before it hits a portal.", "Keep locality, building, broker, and price context together.", "Move from fresh signal to direct WhatsApp action."] .map((item) => (
                <div key={item} className="flex items-start gap-3">
                  <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-[var(--accent-primary)]" aria-hidden="true" />
                  <span>{item}</span>
                </div>
              ))}
            </div>
          </div>
          <p className="mt-16 text-xs text-[var(--text-secondary)]">Private workspace for property professionals.</p>
        </section>

        <section className="mx-auto w-full max-w-md">
          <div className="mb-8 text-center lg:text-left">
            <Link href="/" className="mb-6 inline-flex lg:hidden">
              <img src="/propai-logo.svg" alt="PropAI" className="h-12 w-12" />
            </Link>
            <h2 className="text-2xl font-bold text-[var(--text-primary)]">Welcome back</h2>
            <p className="mt-2 text-sm text-[var(--text-secondary)]">Sign in to your PropAI workspace</p>
          </div>

        <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-6 shadow-[0_12px_32px_rgba(46,42,34,0.08)] sm:p-7">
          <div className="flex gap-1 mb-6 bg-zinc-900 rounded-lg p-1">
            <button
              onClick={() => setMode("email")}
              className={`flex-1 px-3 py-2 text-sm font-medium rounded-md transition-colors ${
                mode === "email" ? "bg-[var(--accent-primary)] text-[#FAF7F0]" : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
              }`}
            >
              Email + Password
            </button>
            <button
              onClick={() => setMode("magic")}
              className={`flex-1 px-3 py-2 text-sm font-medium rounded-md transition-colors ${
                mode === "magic" ? "bg-[var(--accent-primary)] text-[#FAF7F0]" : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
              }`}
            >
              Magic Link
            </button>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor="email" className="block text-[11px] font-semibold text-zinc-500 uppercase tracking-wider mb-1">
                Email
              </label>
              <div className="relative mt-1">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
                <input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoComplete="email"
                  className="w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-base)] py-2.5 pl-10 pr-4 text-sm text-[var(--text-primary)] outline-none placeholder:text-[var(--text-secondary)] transition-colors focus:border-[var(--accent-primary)] focus:ring-1 focus:ring-[var(--accent-primary)]"
                  placeholder="you@company.com"
                  disabled={loading}
                />
              </div>
            </div>

            {mode === "email" && (
              <div>
                <label htmlFor="password" className="block text-[11px] font-semibold text-zinc-500 uppercase tracking-wider mb-1">
                  Password
                </label>
                <div className="relative mt-1">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
                  <input
                    id="password"
                    type={showPassword ? "text" : "password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    autoComplete="current-password"
                    className="w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-base)] py-2.5 pl-10 pr-12 text-sm text-[var(--text-primary)] outline-none placeholder:text-[var(--text-secondary)] transition-colors focus:border-[var(--accent-primary)] focus:ring-1 focus:ring-[var(--accent-primary)]"
                    placeholder="••••••••"
                    disabled={loading}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-white"
                  >
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>
            )}

            {error && (
              <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={loading || !email || (mode === "email" && !password)}
              className="flex min-h-[48px] w-full items-center justify-center gap-2 rounded-lg bg-[var(--accent-primary)] px-4 py-2.5 text-sm font-bold text-[#FAF7F0] transition-all hover:-translate-y-0.5 hover:bg-[var(--accent-primary-hover)] hover:shadow-[0_8px_18px_rgba(63,90,58,0.18)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {loading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>Signing in…</span>
                </>
              ) : mode === "email" ? (
                <>
                  Sign in
                  <ArrowRight className="w-4 h-4" />
                </>
              ) : (
                <>
                  Send Magic Link
                  <ArrowRight className="w-4 h-4" />
                </>
              )}
            </button>
          </form>

          <div className="mt-6 text-center text-sm text-[var(--text-secondary)]">
            Don&apos;t have an account?{" "}
            <Link href={`/auth/signup?next=${encodeURIComponent(next)}`} className="font-medium text-[var(--accent-primary)] hover:text-[var(--accent-primary-hover)]">
              Sign up
            </Link>
          </div>
        </div>
        </section>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return <LoginContent />;
}
