"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Check, ChevronRight, Loader2, MessageSquare, Network, Smartphone, Sparkles, X } from "lucide-react";
import { fetchJSON, getMarketAccessStatus, type MarketAccessStatus } from "@/lib/api";
import { useAuth } from "@/lib/AuthProvider";

const DISMISS_KEY_PREFIX = "propai_setup_dismissed";
const INSTINCT_WORKSPACE_URL = "https://app.instinct.com";

type StepState = "done" | "active" | "todo";

type GuideStep = {
  id: string;
  title: string;
  body: string;
  state: StepState;
  note?: string;
  cta?: { href: string; label: string; external?: boolean };
  secondaryCta?: { href: string; label: string };
};

type ExternalKeyRow = { id: string; revoked_at?: string | null; expires_at?: string | null };

function stepState(done: boolean, previousDone: boolean): StepState {
  if (done) return "done";
  return previousDone ? "active" : "todo";
}

function keyIsUsable(key: ExternalKeyRow): boolean {
  if (key.revoked_at) return false;
  if (!key.expires_at) return true;
  const expiry = new Date(key.expires_at).getTime();
  return Number.isNaN(expiry) ? false : expiry > Date.now();
}

export default function SetupGuide({ variant = "page" }: { variant?: "page" | "card" }) {
  const { user } = useAuth();
  const dismissKey = `${DISMISS_KEY_PREFIX}:${user?.id || "anonymous"}`;
  const [access, setAccess] = useState<MarketAccessStatus | null>(null);
  const [assistantConnected, setAssistantConnected] = useState<boolean | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setDismissed(window.localStorage.getItem(dismissKey) === "1");
    setHydrated(true);
  }, [dismissKey]);

  const load = useCallback(async () => {
    try {
      const status = await getMarketAccessStatus();
      setAccess(status);
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
    try {
      const result = await fetchJSON<{ keys: ExternalKeyRow[] }>("/external/v1/keys");
      setAssistantConnected((result.keys || []).some(keyIsUsable));
    } catch {
      setAssistantConnected(null);
    }
  }, []);

  useEffect(() => {
    void load();
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [load]);

  if (!hydrated || dismissed) {
    if (variant === "page" && hydrated && dismissed) {
      return (
        <div className="rounded-2xl border border-white/10 bg-zinc-950 p-6 text-center">
          <p className="text-sm text-zinc-400">You hid the setup guide.</p>
          <button
            type="button"
            onClick={() => {
              window.localStorage.removeItem(dismissKey);
              setDismissed(false);
            }}
            className="mt-3 rounded-lg border border-emerald-400/40 bg-emerald-500/10 px-4 py-2 text-xs font-semibold text-emerald-200 hover:bg-emerald-500/20"
          >
            Show it again
          </button>
        </div>
      );
    }
    return null;
  }

  // Under a load failure nothing is known: no step may present itself as
  // "up next", because that would be an unverified progress suggestion.
  const statusKnown = access !== null && !loadError;
  const whatsappConnected = access?.whatsapp_connected === true;
  // Step 2 completes on an actual confirmed market group, never on sync state.
  const groupsConfirmed = access?.market_groups_confirmed === true;
  // Step 3 completes when a usable assistant key EXISTS. A key proves the
  // connection was approved, not that an assistant has answered yet; the
  // step copy says exactly that.
  const assistantDone = assistantConnected === true;
  // Step 4 completes only on EXPLICIT first-search provenance. Pre-existing
  // rows (auth-era starts, any window length) carry no provenance marker, so
  // they must never count as a proven first search - dates alone say nothing.
  const firstSearchDone = access?.trial_first_search === true;
  // Workspaces that predate this tracker: whether they have asked a first
  // question is UNKNOWN. Show that truthfully instead of a permanently
  // pending "up next" they can never clear.
  const firstQuestionUnknown =
    !firstSearchDone && access != null && access.trial_first_search == null && Boolean(access.trial_started_at);

  const steps: GuideStep[] = [
    {
      id: "whatsapp",
      title: "Connect your WhatsApp",
      body: "Pair the WhatsApp number you use for broker groups. PropAI privately saves the text of new group messages it captures into your workspace. Private WhatsApp messages are not ingested or available to assistants.",
      state: stepState(whatsappConnected, statusKnown),
      cta: { href: "/whatsapp?tab=numbers", label: whatsappConnected ? "Manage numbers" : "Connect WhatsApp" },
    },
    {
      id: "groups",
      title: "Choose your market groups",
      body: "Captured group messages stay saved privately either way. Checking a group here means its listings join the shared market that other brokers search. Unchecked groups stay private to your workspace; private WhatsApp messages are not captured.",
      state: stepState(groupsConfirmed, statusKnown && whatsappConnected),
      cta: { href: "/whatsapp?tab=groups", label: "Choose groups" },
    },
    {
      id: "assistant",
      title: "Approve your assistant's access",
      body: "Ask Instinct to connect to PropAI. It shows you an access request: sign in with your usual PropAI account, check what is being asked and approve. The PropAI connection is created and stored behind the scenes - you never handle it. Once approved, it shows here as available; the last step proves the connection with a real answer. Private messages are not ingested or available. You approve every connection.",
      // assistantConnected === null means the key read failed, so the step
      // stays neutral instead of urging a connection that may already exist.
      state: stepState(assistantDone, statusKnown && whatsappConnected && assistantConnected !== null),
      cta: { href: "/workspace/instinct", label: "Connect Instinct" },
      secondaryCta: { href: "/workspace/mcp", label: "Other assistants" },
    },
    {
      id: "first-question",
      title: "Ask your first question",
      body: 'Try asking your assistant: "Find a furnished 2BHK around Pali Hill or Carter Road, budget 1.2 lakh." It answers from your own groups and the shared market, so you search in plain language instead of scrolling chats.',
      state: firstSearchDone
        ? "done"
        : firstQuestionUnknown
          ? "todo"
          : stepState(false, statusKnown && assistantDone),
      note: firstQuestionUnknown
        ? "Your workspace started before this tracker, so we can't tell whether you've already asked your first question. If you haven't, asking one now is still the best test."
        : undefined,
      cta: { href: INSTINCT_WORKSPACE_URL, label: "Open Instinct", external: true },
    },
  ];

  const doneCount = steps.filter((step) => step.state === "done").length;

  // Free-period display, driven by the real trial state from /api/market/access.
  // "unknown" (read failure, malformed data) shows nothing rather than a false promise.
  const trialLine = (() => {
    if (!access) return null;
    switch (access.trial_state) {
      case "not_started":
        return "Your 15 free days start with your first assistant search.";
      case "active": {
        if (!access.trial_ends_at) return "Your free period is active.";
        const msLeft = new Date(access.trial_ends_at).getTime() - Date.now();
        if (Number.isNaN(msLeft) || msLeft <= 0) return null;
        const daysLeft = Math.ceil(msLeft / (24 * 60 * 60 * 1000));
        return `Free period: ${daysLeft} day${daysLeft === 1 ? "" : "s"} left. Want a nudge? Ask your assistant to remind you before they run out.`;
      }
      case "expired":
        return "Your free period has ended.";
      default:
        return null;
    }
  })();

  return (
    <section
      aria-label="PropAI setup guide"
      className={`rounded-2xl border border-emerald-400/20 bg-zinc-950 ${variant === "card" ? "p-5" : "p-6 sm:p-8"}`}
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-emerald-300">Get set up</p>
          <h2 className={`mt-1 font-semibold text-white ${variant === "card" ? "text-base" : "text-xl"}`}>
            Four steps to your first answer
          </h2>
          <p className="mt-1 text-xs leading-5 text-zinc-400">
            Connect WhatsApp, pick your market groups, connect your assistant, then ask it for a property in plain
            language.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            window.localStorage.setItem(dismissKey, "1");
            setDismissed(true);
          }}
          className="shrink-0 rounded-lg p-1.5 text-zinc-500 hover:bg-white/5 hover:text-white"
          aria-label="Hide setup guide"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-zinc-500">
        {loadError ? (
          <span>Setup status could not be loaded; the links below still work.</span>
        ) : access === null ? (
          <span className="inline-flex items-center gap-1.5">
            <Loader2 className="h-3 w-3 animate-spin" /> Checking your setup...
          </span>
        ) : (
          <span>
            {doneCount} of {steps.length} steps done
          </span>
        )}
        {trialLine && <span className="text-emerald-300/90">{trialLine}</span>}
      </div>

      <ol className="mt-4 space-y-3">
        {steps.map((step, index) => {
          const Icon = [Smartphone, MessageSquare, Network, Sparkles][index] ?? Sparkles;
          return (
            <li
              key={step.id}
              className={`rounded-xl border p-4 ${
                step.state === "done"
                  ? "border-emerald-400/20 bg-emerald-500/[0.05]"
                  : step.state === "active"
                    ? "border-white/15 bg-white/[0.04]"
                    : "border-white/8 bg-white/[0.015] opacity-75"
              }`}
            >
              <div className="flex items-start gap-3">
                <div
                  className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border ${
                    step.state === "done"
                      ? "border-emerald-400/30 bg-emerald-500/15 text-emerald-300"
                      : "border-white/10 bg-white/[0.03] text-zinc-300"
                  }`}
                >
                  {step.state === "done" ? <Check className="h-4 w-4" /> : <Icon className="h-4 w-4" />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold text-white">
                      {index + 1}. {step.title}
                    </span>
                    {step.state === "active" && (
                      <span className="rounded-full border border-amber-300/30 bg-amber-300/10 px-2 py-0.5 text-[10px] font-semibold text-amber-200">
                        Up next
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-xs leading-5 text-zinc-400">{step.body}</p>
                  {step.note && <p className="mt-1 text-[11px] leading-4 text-zinc-500">{step.note}</p>}
                  {(step.cta || step.secondaryCta) && (
                    <div className="mt-2.5 flex flex-wrap gap-2">
                      {step.cta &&
                        (step.cta.external ? (
                          <a
                            href={step.cta.href}
                            target="_blank"
                            rel="noreferrer"
                            className="setup-guide-cta inline-flex items-center gap-1 rounded-lg bg-emerald-400 px-3 py-1.5 text-[11px] font-semibold text-black hover:bg-emerald-300"
                          >
                            {step.cta.label} <ChevronRight className="h-3 w-3" />
                          </a>
                        ) : (
                          <Link
                            href={step.cta.href}
                            className="setup-guide-cta inline-flex items-center gap-1 rounded-lg bg-emerald-400 px-3 py-1.5 text-[11px] font-semibold text-black hover:bg-emerald-300"
                          >
                            {step.cta.label} <ChevronRight className="h-3 w-3" />
                          </Link>
                        ))}
                      {step.secondaryCta && (
                        <Link
                          href={step.secondaryCta.href}
                          className="inline-flex items-center gap-1 rounded-lg border border-white/15 px-3 py-1.5 text-[11px] font-semibold text-zinc-300 hover:bg-white/5"
                        >
                          {step.secondaryCta.label}
                        </Link>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
