"use client";

import { useState } from "react";
import { AlertCircle, ArrowRight, CheckCircle, Eye, EyeOff, Loader2, Lock, Mail, User, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { sendPasswordReset, signInWithEmail, signInWithMagicLink, signUp } from "@/lib/auth";

type AccessMode = "signin" | "signup";

export default function BrokerAccessPanel({ onClose, nextPath = "/inbox" }: { onClose: () => void; nextPath?: string }) {
  const router = useRouter();
  const [mode, setMode] = useState<AccessMode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [workspaceName, setWorkspaceName] = useState("");
  const [phone, setPhone] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const [accountCreated, setAccountCreated] = useState(false);

  function switchMode(nextMode: AccessMode) {
    setMode(nextMode);
    setAccountCreated(false);
    setMessage(null);
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(null);
    setLoading(true);

    try {
      if (mode === "signin") {
        await signInWithEmail(email.trim(), password);
        router.push(nextPath);
        router.refresh();
        return;
      }

      const phoneDigits = phone.replace(/\D/g, "");
      if (password.length < 8) throw new Error("Use at least 8 characters for your password.");
      if (phoneDigits.length < 10 || phoneDigits.length > 15) throw new Error("Enter a valid WhatsApp/mobile number.");

      await signUp(
        email.trim(),
        password,
        `${window.location.origin}/auth/callback`,
        fullName.trim(),
        workspaceName.trim() || undefined,
        phoneDigits,
      );
      setAccountCreated(true);
      setMessage({ kind: "success", text: "Check your email to confirm your PropAI workspace." });
    } catch (error: unknown) {
      setMessage({ kind: "error", text: error instanceof Error ? error.message : "We could not complete that request." });
    } finally {
      setLoading(false);
    }
  }

  async function sendMagicLink() {
    if (!email.trim()) {
      setMessage({ kind: "error", text: "Enter your email first." });
      return;
    }
    setLoading(true);
    setMessage(null);
    try {
      await signInWithMagicLink(email.trim(), `${window.location.origin}/auth/callback`);
      setMessage({ kind: "success", text: "Magic link sent. Check your email to continue." });
    } catch (error: unknown) {
      setMessage({ kind: "error", text: error instanceof Error ? error.message : "We could not send the magic link." });
    } finally {
      setLoading(false);
    }
  }

  async function sendResetLink() {
    if (!email.trim()) {
      setMessage({ kind: "error", text: "Enter your email first." });
      return;
    }
    setLoading(true);
    setMessage(null);
    try {
      await sendPasswordReset(email.trim(), `${window.location.origin}/auth/reset`);
      setMessage({ kind: "success", text: "Password reset link sent. Check your email to continue." });
    } catch (error: unknown) {
      setMessage({ kind: "error", text: error instanceof Error ? error.message : "We could not send the reset link." });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="broker-access-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="broker-access-panel" role="dialog" aria-modal="true" aria-labelledby="broker-access-title">
        <button type="button" className="broker-access-close" onClick={onClose} aria-label="Close account access"><X className="h-4 w-4" /></button>
        <p className="broker-mono-label">PropAI Broker OS</p>
        <h2 id="broker-access-title">{mode === "signin" ? "Welcome back." : "Start with your market."}</h2>
        <p className="broker-access-copy">{mode === "signin" ? "Sign in to open your workspace." : "Create one workspace for the WhatsApp market you already have."}</p>

        <div className="broker-access-tabs" role="tablist" aria-label="Account access">
          <button type="button" role="tab" aria-selected={mode === "signin"} className={mode === "signin" ? "is-active" : ""} onClick={() => switchMode("signin")}>Sign in</button>
          <button type="button" role="tab" aria-selected={mode === "signup"} className={mode === "signup" ? "is-active" : ""} onClick={() => switchMode("signup")}>Create account</button>
        </div>

        {message && <div className={`broker-access-message ${message.kind === "error" ? "is-error" : "is-success"}`} role={message.kind === "error" ? "alert" : "status"}>{message.kind === "error" ? <AlertCircle className="h-4 w-4" /> : <CheckCircle className="h-4 w-4" />}<span>{message.text}</span></div>}

        {accountCreated && mode === "signup" ? (
          <div className="broker-access-created mt-6 rounded-lg p-5 text-center">
            <CheckCircle className="mx-auto h-8 w-8 text-[var(--signal)]" />
            <h3 className="mt-3 text-lg font-semibold">Check your email</h3>
            <p className="mt-2 text-sm text-[var(--text-secondary)]">Your workspace is created. Confirm your email to finish setting up access.</p>
            <button type="button" className="broker-button broker-button-large mt-5 w-full" onClick={() => switchMode("signin")}>Back to sign in <ArrowRight className="h-4 w-4" /></button>
          </div>
        ) : <form onSubmit={submit} className="broker-access-form">
          {mode === "signup" && <>
            <label><span><User className="h-3.5 w-3.5" /> Your name</span><input value={fullName} onChange={(event) => setFullName(event.target.value)} required autoComplete="name" placeholder="Vishal Ojha" /></label>
            <label><span>Brokerage or workspace <small>optional</small></span><input value={workspaceName} onChange={(event) => setWorkspaceName(event.target.value)} autoComplete="organization" placeholder="Your brokerage" /></label>
            <label><span>WhatsApp number</span><input value={phone} onChange={(event) => setPhone(event.target.value)} required inputMode="tel" autoComplete="tel" placeholder="98765 43210" /></label>
          </>}
          <label><span><Mail className="h-3.5 w-3.5" /> Email</span><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required autoComplete="email" placeholder="you@brokerage.com" /></label>
          <label><span><Lock className="h-3.5 w-3.5" /> Password</span><div className="broker-access-password"><input type={showPassword ? "text" : "password"} value={password} onChange={(event) => setPassword(event.target.value)} required autoComplete={mode === "signin" ? "current-password" : "new-password"} placeholder="At least 8 characters" /><button type="button" onClick={() => setShowPassword((value) => !value)} aria-label={showPassword ? "Hide password" : "Show password"}>{showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}</button></div></label>
          <button type="submit" className="broker-button broker-button-large broker-access-submit" disabled={loading}>{loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <>{mode === "signin" ? "Open workspace" : "Create workspace"}<ArrowRight className="h-4 w-4" /></>}</button>
        </form>}

        {mode === "signin" && <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2">
          <button type="button" className="broker-access-magic" onClick={sendMagicLink} disabled={loading}>Send me a magic link instead</button>
          <button type="button" className="broker-access-magic" onClick={sendResetLink} disabled={loading}>Forgot password?</button>
        </div>}
      </section>
    </div>
  );
}
