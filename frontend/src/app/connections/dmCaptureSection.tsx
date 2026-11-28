"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, MessageSquare } from "lucide-react";
import { formatPhoneWithCountry, formatSuggestedSender, sameSenderIdentity } from "@/lib/phoneDisplay";
import { getDMCaptureSenders, setDMCaptureSenders } from "@/lib/api";
import {
  addTypedSender,
  buildDMCaptureOutcomeMessage,
  buildEnablePayload,
  DM_CAPTURE_CONSENT_VERSION,
  EMPTY_DM_CAPTURE,
  type DMCaptureState,
} from "./dmCapture";

/**
 * Optional per-sender capture of property-listing direct messages.
 *
 * Scope presented to the user, matching the server gates: only senders they
 * explicitly select, only messages that look like property listings,
 * searchable only in their own account, never shared with other brokers.
 * Hidden entirely when the backend does not offer the feature.
 */
export function DMCaptureSection({ phoneId }: { phoneId: number }) {
  const [state, setState] = useState<DMCaptureState>(EMPTY_DM_CAPTURE);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [typed, setTyped] = useState("");
  const [typedError, setTypedError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<DMCaptureState> => {
    try {
      const raw = await getDMCaptureSenders(phoneId);
      const snapshot: DMCaptureState = {
        available: true,
        consentVersion: raw.consent_version,
        consentText: raw.consent_text,
        active: raw.senders || [],
        revoked: raw.revoked_senders || [],
        suggested: raw.suggested_phones || [],
      };
      setState(snapshot);
      return snapshot;
    } catch {
      // Feature unavailable (older backend or migration not applied): hide it.
      setState(EMPTY_DM_CAPTURE);
      return EMPTY_DM_CAPTURE;
    }
  }, [phoneId]);

  useEffect(() => {
    void load();
  }, [load]);

  const activePhones = new Set(state.active.map((row) => row.sender_phone));
  const newChecked = Array.from(checked).filter((phone) => !activePhones.has(phone));

  const confirmEnable = useCallback(async () => {
    if (saving || newChecked.length === 0) return;
    setSaving(true);
    setError(null);
    try {
      const attempted = newChecked;
      await setDMCaptureSenders(phoneId, buildEnablePayload(checked, state.active, {}), true, state.consentVersion || DM_CAPTURE_CONSENT_VERSION);
      const after = await load();
      setChecked(new Set());
      setTyped("");
      setMessage(buildDMCaptureOutcomeMessage({
        attemptedEnable: attempted,
        attemptedRevoke: [],
        beforeActive: activePhones,
        afterActive: new Set(after.active.map((row) => row.sender_phone)),
      }));
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : "Could not save the sender choices; nothing was changed.");
    } finally {
      setSaving(false);
    }
  }, [saving, newChecked.length, phoneId, checked, state.active, state.consentVersion, load]);

  const removeSender = useCallback(async (phone: string) => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      await setDMCaptureSenders(phoneId, [{ phone }], false, state.consentVersion || DM_CAPTURE_CONSENT_VERSION);
      const after = await load();
      setMessage(buildDMCaptureOutcomeMessage({
        attemptedEnable: [],
        attemptedRevoke: [phone],
        beforeActive: activePhones,
        afterActive: new Set(after.active.map((row) => row.sender_phone)),
      }));
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : "Could not remove the sender; nothing was changed.");
    } finally {
      setSaving(false);
    }
  }, [saving, phoneId, state.consentVersion, state.active, load]);

  if (!state.available) return null;

  const addTyped = () => {
    const result = addTypedSender(checked, typed);
    if (result.rejected) {
      setTypedError("Enter the sender's full phone number with country code, for example 919812345678.");
      return;
    }
    setTypedError(null);
    setTyped("");
    setChecked(result.checked);
  };

  return (
    <div className="mt-4 rounded-lg border border-sky-400/20 bg-sky-500/[0.04] px-3 py-2.5 text-xs text-sky-100">
      <div className="flex items-center gap-2 font-semibold">
        <MessageSquare className="h-3.5 w-3.5" />
        Broker direct messages · optional
      </div>
      <p className="mt-1 leading-5 text-sky-100/80">
        Some brokers send listings as direct messages (broadcast lists arrive this way). Choose those senders below and only their property-looking messages are saved for your own chat search. Other personal chats are never saved, and saved messages are never shared with other brokers.
      </p>

      {state.active.length > 0 && (
        <div className="mt-2">
          <p className="text-[11px] font-semibold text-sky-200">Capturing from {state.active.length} sender{state.active.length === 1 ? "" : "s"}</p>
          <ul className="mt-1 space-y-1">
            {state.active.map((row) => (
              <li key={row.sender_phone} className="flex items-center justify-between gap-2 rounded-md border border-white/10 px-2 py-1">
                <span className="truncate">{row.display_name && row.display_name !== row.sender_phone ? `${row.display_name} · ` : ""}{formatPhoneWithCountry(row.sender_phone).startsWith("+") ? formatPhoneWithCountry(row.sender_phone) : `+${row.sender_phone}`}</span>
                <button type="button" disabled={saving} onClick={() => void removeSender(row.sender_phone)} className="shrink-0 rounded-md border border-red-400/30 px-2 py-0.5 text-[11px] font-semibold text-red-300 hover:bg-red-500/10 disabled:opacity-40">
                  Remove
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {state.suggested.length > 0 && (
        <div className="mt-2">
          <p className="text-[11px] font-semibold text-sky-200">Brokers seen in your groups</p>
          <div className="mt-1 max-h-32 space-y-1 overflow-y-auto pr-1">
            {state.suggested.map((phone) => {
              const isActive = activePhones.has(phone) || state.active.some((row) => sameSenderIdentity(row.sender_phone, phone));
              return (
                <label key={phone} className={`flex items-center gap-1.5 ${isActive ? "opacity-50" : ""}`}>
                  <input
                    type="checkbox"
                    className="h-3 w-3 accent-sky-400"
                    disabled={isActive || saving}
                    checked={isActive || checked.has(phone)}
                    onChange={() => setChecked((current) => { const next = new Set(current); if (next.has(phone)) { next.delete(phone); } else { next.add(phone); } return next; })}
                  />
                  <span title="Stored without a country code; not changed">{formatSuggestedSender(phone)}{isActive ? " (already selected)" : ""}</span>
                </label>
              );
            })}
          </div>
        </div>
      )}

      <div className="mt-2 flex items-center gap-2">
        <input
          type="text"
          inputMode="tel"
          value={typed}
          disabled={saving}
          onChange={(event) => { setTyped(event.target.value); setTypedError(null); }}
          placeholder="Add sender phone, e.g. 919812345678"
          className="min-w-0 flex-1 rounded-md border border-white/10 bg-zinc-950 px-2 py-1.5 text-[11px] text-zinc-200 placeholder:text-zinc-600"
        />
        <button type="button" disabled={saving || !typed.trim()} onClick={addTyped} className="shrink-0 rounded-md border border-sky-400/40 px-2 py-1.5 text-[11px] font-semibold text-sky-200 hover:bg-sky-500/10 disabled:opacity-40">
          Add
        </button>
      </div>
      {typedError && <p className="mt-1 text-[11px] text-amber-200">{typedError}</p>}

      {newChecked.length > 0 && (
        <div className="mt-2 rounded-md border border-white/10 px-2 py-2">
          <p className="text-[11px] leading-4 text-sky-100/80">{state.consentText}</p>
          <button type="button" disabled={saving} onClick={() => void confirmEnable()} className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-sky-400 px-3 py-1.5 text-[11px] font-semibold text-black hover:bg-sky-300 disabled:cursor-not-allowed disabled:opacity-40">
            <Check className="h-3 w-3" /> {saving ? "Saving..." : `Allow saving from ${newChecked.length} sender${newChecked.length === 1 ? "" : "s"}`}
          </button>
        </div>
      )}

      {state.revoked.length > 0 && (
        <p className="mt-2 text-[10px] leading-4 text-sky-100/60">
          Stopped: {state.revoked.map((row) => `+${row.sender_phone}`).join(", ")}. Reconnecting WhatsApp or removing a sender stops capture until you confirm again.
        </p>
      )}
      {message && <p className="mt-2 text-[11px] text-emerald-300">{message}</p>}
      {error && <p className="mt-2 text-[11px] text-red-300">{error}</p>}
    </div>
  );
}
