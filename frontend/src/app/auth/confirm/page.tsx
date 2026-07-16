"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2, CheckCircle, AlertCircle, ArrowRight } from "lucide-react";
import { getSupabase } from "@/lib/auth";

const AUTH_NEXT_KEY = "propai_auth_next";

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
      const storedNext = window.localStorage.getItem(AUTH_NEXT_KEY) || "";
      const next = params.get("next") || storedNext || "/";
      if (storedNext) {
        window.localStorage.removeItem(AUTH_NEXT_KEY);
      }
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
              type: type as "email" | "recovery" | "invite" | "email_change" | "phone_change" | "magiclink" | "signup",
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
      } catch (error: unknown) {
        setStatus("error");
        setMessage(error instanceof Error ? error.message : "Email confirmation failed");
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
          <Link
            href="/auth/login"
            className="flex items-center gap-2 px-4 py-2 bg-emerald-400 text-black rounded-lg text-sm font-bold hover:bg-emerald-300 transition-colors"
          >
            <ArrowRight className="w-4 h-4" />
            Sign in
          </Link>
          <Link
            href="/auth/signup"
            className="px-4 py-2 border border-white/10 text-zinc-400 rounded-lg text-sm hover:bg-white/5 transition-colors"
          >
            Sign up again
          </Link>
        </div>
      </div>
    </div>
  );
}
