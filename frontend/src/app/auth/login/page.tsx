"use client";

export const dynamic = 'force-dynamic';

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Mail, Lock, Eye, EyeOff, ArrowRight, AlertCircle, Loader2 } from "lucide-react";
import { signInWithEmail, signInWithMagicLink, getSession } from "@/lib/auth";

function LoginContent() {
  const router = useRouter();
  const [next, setNext] = useState("/");

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
        await signInWithMagicLink(email, `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`);
        alert("Magic link sent! Check your email.");
        return;
      }

      router.push(next);
      router.refresh();
    } catch (e: any) {
      setError(e.message || "Sign in failed");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const target = params.get("next") || "/";
    setNext(target);

    getSession().then((session) => {
      if (session) router.push(target);
    });
  }, [router]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-black px-4 py-12">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <Link href="/" className="inline-block mb-6">
            <svg className="w-12 h-12 mx-auto" viewBox="0 0 32 32" fill="none">
              <rect width="32" height="32" rx="8" fill="#0B0F14" stroke="#3EE88A" strokeWidth="1.5"/>
              <path d="M8 16L14 22L24 10" stroke="#3EE88A" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </Link>
          <h1 className="text-2xl font-bold text-white">Welcome back</h1>
          <p className="mt-2 text-sm text-zinc-500">Sign in to your PropAI workspace</p>
        </div>

        <div className="rounded-2xl border border-white/10 bg-zinc-950/50 p-6">
          <div className="flex gap-1 mb-6 bg-zinc-900 rounded-lg p-1">
            <button
              onClick={() => setMode("email")}
              className={`flex-1 px-3 py-2 text-sm font-medium rounded-md transition-colors ${
                mode === "email" ? "bg-emerald-400 text-black" : "text-zinc-400 hover:text-white"
              }`}
            >
              Email + Password
            </button>
            <button
              onClick={() => setMode("magic")}
              className={`flex-1 px-3 py-2 text-sm font-medium rounded-md transition-colors ${
                mode === "magic" ? "bg-emerald-400 text-black" : "text-zinc-400 hover:text-white"
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
                  className="w-full pl-10 pr-4 py-2.5 bg-zinc-800/50 border border-white/10 rounded-lg text-sm text-white placeholder-zinc-500 outline-none focus:border-emerald-400/50 focus:ring-1 focus:ring-emerald-400/50 transition-colors"
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
                    className="w-full pl-10 pr-12 py-2.5 bg-zinc-800/50 border border-white/10 rounded-lg text-sm text-white placeholder-zinc-500 outline-none focus:border-emerald-400/50 focus:ring-1 focus:ring-emerald-400/50 transition-colors"
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
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-emerald-400 text-black rounded-lg text-sm font-bold min-h-[48px] disabled:opacity-50 disabled:cursor-not-allowed transition-opacity"
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

          <div className="mt-6 text-center text-sm text-zinc-500">
            Don't have an account?{" "}
            <Link href={`/auth/signup?next=${encodeURIComponent(next)}`} className="text-emerald-400 hover:text-emerald-300 font-medium">
              Sign up
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return <LoginContent />;
}
