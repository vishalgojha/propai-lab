"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Bot, X, RefreshCw } from "lucide-react";
import { fetchJSON, getPhones, type Phone } from "@/lib/api";

// Floating "Assistant access" widget: shows, in plain language, what the
// connected assistant (Instinct) can currently read or write in this
// workspace, and deep-links to the full-page controls. It never changes any
// setting itself.
//
// Truthfulness rules baked in here:
// - Connection status comes only from /external/v1/connection-status, which
//   binds to the actual connect-session key. If that endpoint is unavailable
//   we show "unavailable" instead of guessing from an aggregate of all keys.
// - Own-capture groups (messages your connected numbers save) stay separate
//   from pooled raw sharing (groups you explicitly share with other brokers).
// - Private DMs show On only when BOTH workspace DM consent and the bound
//   key's DM permission are reported by the API.

const DISMISS_KEY = "propai.assistantAccess.dismissed";
const RESET_EVENT = "propai:assistant-access-reset";

type ConnectionStatus = {
  dm_consent_enabled: boolean;
  connection: null | {
    label: string;
    key_revoked: boolean;
    can_read_groups: boolean;
    can_read_dms: boolean;
    can_write_private_crm: boolean;
    last_used_at: string | null;
  };
  unbound_active_keys: number;
};

type AccessState =
  | { kind: "loading" }
  | { kind: "unavailable" }
  | {
      kind: "ready";
      status: ConnectionStatus;
      whatsappConnected: boolean;
      pooledSharingAvailable: boolean;
      pooledSharedGroups: number | null;
    };

async function loadAccessState(): Promise<AccessState> {
  let status: ConnectionStatus;
  try {
    status = await fetchJSON<ConnectionStatus>("/external/v1/connection-status");
  } catch {
    return { kind: "unavailable" };
  }
  let phones: Phone[] = [];
  try {
    const result = await getPhones();
    phones = (result as { phones?: Phone[] }).phones ?? (Array.isArray(result) ? (result as Phone[]) : []);
  } catch {
    phones = [];
  }
  const whatsappConnected = phones.some((phone) => phone.is_active && phone.connected === true);
  let pooledSharingAvailable = false;
  let pooledSharedGroups: number | null = 0;
  try {
    const policy = await fetchJSON<{ enabled: boolean }>("/external/v1/market/policy");
    pooledSharingAvailable = Boolean(policy.enabled);
    if (pooledSharingAvailable) {
      const active = phones.filter((phone) => phone.is_active);
      const counts = await Promise.all(
        active.map(async (phone) => {
          const sources = await fetchJSON<{ active_sources: unknown[] }>(
            `/external/v1/market/raw-sources?whatsapp_connection_id=${phone.id}`
          );
          return (sources.active_sources || []).length;
        })
      );
      pooledSharedGroups = counts.reduce((sum, count) => sum + count, 0);
    }
  } catch {
    pooledSharedGroups = null;
  }
  return { kind: "ready", status, whatsappConnected, pooledSharingAvailable, pooledSharedGroups };
}

function Dot({ on, warn }: { on: boolean; warn?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`mt-1 inline-block h-2 w-2 shrink-0 rounded-full ${on ? "bg-emerald-400" : warn ? "bg-amber-400" : "bg-zinc-500"}`}
    />
  );
}

function Row({
  on,
  warn,
  title,
  state,
  benefit,
  linkHref,
  linkLabel,
}: {
  on: boolean;
  warn?: boolean;
  title: string;
  state: string;
  benefit: string;
  linkHref: string;
  linkLabel: string;
}) {
  return (
    <li className="flex items-start gap-2.5">
      <Dot on={on} warn={warn} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-xs font-semibold text-white">{title}</span>
          <span className={`text-[11px] font-medium ${on ? "text-emerald-300" : warn ? "text-amber-300" : "text-zinc-400"}`}>{state}</span>
        </div>
        <p className="mt-0.5 text-[11px] leading-4 text-zinc-400">{benefit}</p>
        <Link href={linkHref} className="mt-0.5 inline-block text-[11px] font-medium text-amber-200 hover:text-amber-100">
          {linkLabel}
        </Link>
      </div>
    </li>
  );
}

export function AssistantAccessWidget({ enabled }: { enabled: boolean }) {
  const [dismissed, setDismissed] = useState<boolean | null>(null);
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<AccessState>({ kind: "loading" });
  const loaded = useRef(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let stored = false;
    try {
      stored = window.localStorage.getItem(DISMISS_KEY) === "1";
    } catch {
      stored = false;
    }
    setDismissed(stored);
    const onReset = () => {
      try {
        window.localStorage.removeItem(DISMISS_KEY);
      } catch {
        // storage may be unavailable; the widget simply reappears this session
      }
      setDismissed(false);
    };
    window.addEventListener(RESET_EVENT, onReset);
    return () => window.removeEventListener(RESET_EVENT, onReset);
  }, []);

  const refresh = useCallback(() => {
    setState({ kind: "loading" });
    loadAccessState()
      .then((next) => setState(next))
      .catch(() => setState({ kind: "unavailable" }));
  }, []);

  useEffect(() => {
    if (open && !loaded.current) {
      loaded.current = true;
      refresh();
    }
  }, [open, refresh]);

  if (!enabled || dismissed !== false) return null;

  const connection = state.kind === "ready" ? state.status.connection : null;
  const connected = Boolean(connection) && !connection?.key_revoked;

  return (
    <div className="fixed bottom-20 left-4 z-[80] flex flex-col items-start gap-2 lg:bottom-6 lg:left-6" data-testid="assistant-access-widget">
      {open && (
        <section
          aria-label="Assistant access"
          className="max-h-[calc(100dvh-10rem)] w-[19rem] max-w-[calc(100vw-2rem)] overflow-y-auto rounded-2xl border border-border bg-surface p-4 shadow-2xl"
        >
          <div className="flex items-start justify-between gap-2">
            <div>
              <h2 className="text-sm font-semibold text-white">Assistant access</h2>
              <p className="mt-0.5 text-[11px] leading-4 text-zinc-400">
                {state.kind === "ready" && connected
                  ? `${connection?.label || "Instinct"} is linked to this workspace. This is what its key can do right now.`
                  : state.kind === "ready" && connection?.key_revoked
                    ? "The linked assistant key was revoked. Reconnect from the Instinct page."
                    : state.kind === "ready"
                      ? "No assistant connection is set up yet."
                      : "What your assistant can do in this workspace."}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close assistant access panel"
              className="rounded-md p-1 text-zinc-400 hover:bg-surface-hover hover:text-white"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>

          {state.kind === "loading" && <p className="mt-3 text-[11px] text-zinc-400">Checking current access…</p>}

          {state.kind === "unavailable" && (
            <div className="mt-3">
              <p className="text-[11px] leading-4 text-zinc-400">
                Current access status could not be verified. Nothing was changed.
              </p>
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  onClick={refresh}
                  className="inline-flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-[11px] font-medium text-zinc-200 hover:bg-surface-hover"
                >
                  <RefreshCw className="h-3 w-3" /> Retry
                </button>
                <Link href="/workspace/instinct" className="rounded-lg border border-border px-2 py-1 text-[11px] font-medium text-amber-200 hover:bg-surface-hover">
                  Open Instinct settings
                </Link>
              </div>
            </div>
          )}

          {state.kind === "ready" && (
            <>
              <ul className="mt-3 space-y-3">
                <Row
                  on={connected && state.whatsappConnected && Boolean(connection?.can_read_groups)}
                  title="Group messages"
                  state={
                    !connected
                      ? "Off"
                      : !connection?.can_read_groups
                        ? "Off"
                        : state.whatsappConnected
                          ? "On"
                          : "WhatsApp disconnected"
                  }
                  benefit="Answers from WhatsApp group messages your own connected numbers capture: listings, requirements, prices."
                  linkHref="/whatsapp?tab=groups"
                  linkLabel="Manage WhatsApp capture"
                />
                <Row
                  on={connected && Boolean(connection?.can_write_private_crm)}
                  title="Private CRM writes"
                  state={connected && connection?.can_write_private_crm ? "On" : "Off"}
                  benefit="Add and update properties and clients in your private CRM. Writes with contact or price details still need your approval."
                  linkHref="/workspace/mcp#key-access"
                  linkLabel="Manage write access"
                />
                <Row
                  on={connected && Boolean(state.status.dm_consent_enabled && connection?.can_read_dms)}
                  warn={Boolean(state.status.dm_consent_enabled && connected && !connection?.can_read_dms)}
                  title="Private DMs"
                  state={
                    connected && state.status.dm_consent_enabled && connection?.can_read_dms
                      ? "On"
                      : state.status.dm_consent_enabled && connected
                        ? "Needs DM permission on the key"
                        : "Off"
                  }
                  benefit="Search your private one-to-one messages. Phone numbers written as digits are hidden; saved contact names are shown instead."
                  linkHref={
                    state.status.dm_consent_enabled && connected && !connection?.can_read_dms && connection?.key_id
                      ? `/workspace/mcp#key-${connection.key_id}`
                      : "/workspace/mcp#dm-consent"
                  }
                  linkLabel={
                    state.status.dm_consent_enabled && connected && !connection?.can_read_dms
                      ? "Enable DM read on the key"
                      : "Manage DM consent"
                  }
                />
                <Row
                  on={Boolean(state.pooledSharedGroups && state.pooledSharedGroups > 0)}
                  title="Shared with other brokers"
                  state={
                    !state.pooledSharingAvailable
                      ? "Off"
                      : state.pooledSharedGroups === null
                        ? "Unknown"
                        : state.pooledSharedGroups === 0
                          ? "No groups shared"
                          : `${state.pooledSharedGroups} group${state.pooledSharedGroups === 1 ? "" : "s"} shared`
                  }
                  benefit="Only groups you explicitly confirm are shared for broker cross-search. DMs are never shared."
                  linkHref="/connections"
                  linkLabel="Review shared groups"
                />
              </ul>
              {state.status.unbound_active_keys > 0 && (
                <p className="mt-3 rounded-lg border border-border bg-surface-hover px-2 py-1.5 text-[11px] leading-4 text-zinc-400">
                  {state.status.unbound_active_keys} other active manual API{" "}
                  {state.status.unbound_active_keys === 1 ? "key exists" : "keys exist"}. Only the assistant connection shown above
                  reflects your linked assistant.
                </p>
              )}
              <div className="mt-3 flex items-center justify-between gap-2 border-t border-border pt-2.5">
                <Link href="/workspace/instinct" className="text-[11px] font-medium text-amber-200 hover:text-amber-100">
                  All assistant settings
                </Link>
                <button
                  type="button"
                  onClick={() => {
                    try {
                      window.localStorage.setItem(DISMISS_KEY, "1");
                    } catch {
                      // best effort; dismissal still applies to this session
                    }
                    setDismissed(true);
                  }}
                  className="text-[11px] text-zinc-500 hover:text-zinc-300"
                >
                  Hide this widget
                </button>
              </div>
            </>
          )}
        </section>
      )}

      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label={open ? "Close assistant access" : "Open assistant access"}
        className="inline-flex items-center gap-2 rounded-full border border-amber-300/30 bg-surface px-3 py-2 text-xs font-semibold text-amber-200 shadow-xl hover:bg-surface-hover"
      >
        {open ? <X className="h-3.5 w-3.5" /> : <Bot className="h-4 w-4" />}
        Assistant access
      </button>
    </div>
  );
}

export function ShowAssistantAccessButton() {
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    try {
      setHidden(window.localStorage.getItem(DISMISS_KEY) === "1");
    } catch {
      setHidden(false);
    }
  }, []);
  if (!hidden) return null;
  return (
    <button
      type="button"
      onClick={() => {
        try {
          window.localStorage.removeItem(DISMISS_KEY);
        } catch {
          // storage may be unavailable; the widget still reappears this session
        }
        window.dispatchEvent(new Event(RESET_EVENT));
        setHidden(false);
      }}
      className="mt-4 inline-flex items-center gap-2 rounded-lg border border-amber-300/30 px-3 py-2 text-xs font-semibold text-amber-200 hover:bg-amber-300/10"
    >
      Show the floating Assistant access widget again
    </button>
  );
}
