"use client";

export const dynamic = 'force-dynamic';

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, CheckCircle, AlertCircle, ArrowRight } from "lucide-react";
import { getSupabase } from "@/lib/auth";

export default function AuthCallbackPage() {
  const router = useRouter();
  const [status, setStatus] = useState<"loading" | "success" | "error">("loading");
  const [message, setMessage] = useState("");
  const [redirecting, setRedirecting] = useState(false);

  useEffect(() => {
    const handleCallback = async () => {
      const params = new URLSearchParams(window.location.search);
      const code = params.get("code");
      const next = params.get("next") || "/";
      const error = params.get("error");
      const errorDescription = params.get("error_description");

      if (error) {
        setStatus("error");
        setMessage(errorDescription || error);
        return;
      }

      if (!code) {
        setStatus("error");
        setMessage("No authorization code received");
        return;
      }

      try {
        const supabase = getSupabase();
        const { error } = await supabase.auth.exchangeCodeForSession(code);

        if (error) {
          setStatus("error");
          setMessage(error.message);
          return;
        }

        setStatus("success");
        setMessage("Signed in successfully");
        setRedirecting(true);

        // Redirect after short delay
        setTimeout(() => {
          router.push(next);
          router.refresh();
        }, 1500);
      } catch (e: any) {
        setStatus("error");
        setMessage(e.message || "Authentication failed");
      }
    };

    handleCallback();
  }, [router]);

  if (status === "loading") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-black px-4">
        <div className="w-full max-w-md text-center">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-emerald-400/10 mb-4">
            <Loader2 className="w-8 h-8 text-emerald-400 animate-spin" />
          </div>
          <h2 className="text-lg font-semibold text-white">Completing sign in…</h2>
          <p className="mt-2 text-sm text-zinc-500">Please wait while we verify your account</p>
        </div>
      </div>
    );
  }

  if (status === "success") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-black px-4">
        <div className="w-full max-w-md text-center">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-emerald-400/10 mb-4">
            <CheckCircle className="w-8 h-8 text-emerald-400" />
          </div>
          <h2 className="text-lg font-semibold text-white">Signed in successfully</h2>
          <p className="mt-2 text-sm text-zinc-500">Redirecting to your workspace…</p>
          {redirecting && (
            <div className="mt-4 flex items-center justify-center gap-2 text-sm text-emerald-400">
              <span>Redirecting</span>
              <ArrowRight className="w-4 h-4 animate-pulse" />
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-black px-4">
      <div className="w-full max-w-md text-center">
        <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-red-500/10 mb-4">
          <AlertCircle className="w-8 h-8 text-red-400" />
        </div>
        <h2 className="text-lg font-semibold text-white">Sign in failed</h2>
        <p className="mt-2 text-sm text-zinc-500">{message || "An error occurred during authentication"}</p>
        <div className="mt-6 flex gap-3 justify-center">
          <a
            href="/auth/login"
            className="flex items-center gap-2 px-4 py-2 bg-emerald-400 text-black rounded-lg text-sm font-bold hover:bg-emerald-300 transition-colors"
          >
            <ArrowRight className="w-4 h-4" />
            Try again
          </a>
          <a
            href="/"
            className="px-4 py-2 border border-white/10 text-zinc-400 rounded-lg text-sm hover:bg-white/5 transition-colors"
          >
            Go home
          </a>
        </div>
      </div>
    </div>
  );
}
