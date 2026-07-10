"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, CheckCircle, AlertCircle, ArrowRight } from "lucide-react";
import { getSupabase } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default function AuthConfirmPage() {
  const router = useRouter();
  const [status, setStatus] = useState<"loading" | "success" | "error">("loading");
  const [message, setMessage] = useState("");

  useEffect(() => {
    const handleConfirm = async () => {
      const params = new URLSearchParams(window.location.search);
      const tokenHash = params.get("token_hash");
      const type = params.get("type") || "email";
      const code = params.get("code");
      const next = params.get("next") || "/";
      const error = params.get("error");
      const errorDescription = params.get("error_description");

      if (error) {
        setStatus("error");
        setMessage(errorDescription || error);
        return;
      }

      try {
        const supabase = getSupabase();

        if (code) {
          const { error } = await supabase.auth.exchangeCodeForSession(code);
          if (error) throw error;
        } else if (tokenHash) {
          const { error } = await supabase.auth.verifyOtp({
            token_hash: tokenHash,
            type: type as any,
          });
          if (error) throw error;
        } else {
          setStatus("error");
          setMessage("No confirmation token received");
          return;
        }

        setStatus("success");
        setMessage("Email confirmed");
        setTimeout(() => {
          router.push(next);
          router.refresh();
        }, 1200);
      } catch (e: any) {
        setStatus("error");
        setMessage(e.message || "Email confirmation failed");
      }
    };

    handleConfirm();
  }, [router]);

  if (status === "loading") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-black px-4">
        <div className="w-full max-w-md text-center">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-emerald-400/10 mb-4">
            <Loader2 className="w-8 h-8 text-emerald-400 animate-spin" />
          </div>
          <h2 className="text-lg font-semibold text-white">Confirming your email...</h2>
          <p className="mt-2 text-sm text-zinc-500">Please wait while we verify your account.</p>
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
          <h2 className="text-lg font-semibold text-white">Email confirmed</h2>
          <p className="mt-2 text-sm text-zinc-500">{message}. Redirecting...</p>
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
        <h2 className="text-lg font-semibold text-white">Confirmation failed</h2>
        <p className="mt-2 text-sm text-zinc-500">{message || "This confirmation link could not be used."}</p>
        <div className="mt-6 flex gap-3 justify-center">
          <a
            href="/auth/login"
            className="flex items-center gap-2 px-4 py-2 bg-emerald-400 text-black rounded-lg text-sm font-bold hover:bg-emerald-300 transition-colors"
          >
            <ArrowRight className="w-4 h-4" />
            Sign in
          </a>
          <a
            href="/auth/signup"
            className="px-4 py-2 border border-white/10 text-zinc-400 rounded-lg text-sm hover:bg-white/5 transition-colors"
          >
            Sign up again
          </a>
        </div>
      </div>
    </div>
  );
}
