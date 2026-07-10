"use client";

export const dynamic = 'force-dynamic';

import { useEffect, useState } from "react";
import * as api from "@/lib/api";

export default function SettingsPage() {
  const [connState, setConnState] = useState<api.ConnectionState | null>(null);
  const [connDetail, setConnDetail] = useState<any>(null);
  const [aiConfig, setAIConfig] = useState<api.AIConfig | null>(null);
  const [doublewordKey, setDoublewordKey] = useState("");
  const [doublewordModel, setDoublewordModel] = useState("");
  const [aiStatus, setAIStatus] = useState("");
  const [testingAI, setTestingAI] = useState(false);

  useEffect(() => {
    refreshConnection();
    api.getAIConfig().then(setAIConfig).catch(() => {});
    if (typeof window !== "undefined") {
      setDoublewordKey(localStorage.getItem("doubleword_key") || "");
      setDoublewordModel(localStorage.getItem("doubleword_model") || "");
    }
  }, []);

  const connected = connDetail?.connected ?? connState?.connected ?? false;

  async function refreshConnection() {
    const detail = await api.getConnectionDetail().catch(() => null);
    if (detail) {
      setConnDetail(detail);
      setConnState({
        state: detail.connection_state || detail.state || "unknown",
        connected: Boolean(detail.connected),
      });
      return;
    }
    api.getConnectionState().then(setConnState).catch(() => {});
  }

  function saveDoublewordKey() {
    if (typeof window === "undefined") return;
    const key = doublewordKey.trim();
    const model = doublewordModel.trim();
    if (key) {
      localStorage.setItem("doubleword_key", key);
    } else {
      localStorage.removeItem("doubleword_key");
    }
    if (model) {
      localStorage.setItem("doubleword_model", model);
    } else {
      localStorage.removeItem("doubleword_model");
    }
    setAIStatus(key || model ? "Doubleword settings saved in this browser." : "Doubleword settings cleared.");
  }

  function clearDoublewordKey() {
    if (typeof window !== "undefined") localStorage.removeItem("doubleword_key");
    if (typeof window !== "undefined") localStorage.removeItem("doubleword_model");
    setDoublewordKey("");
    setDoublewordModel("");
    setAIStatus("Doubleword settings cleared.");
  }

  async function testDoublewordKey() {
    setTestingAI(true);
    setAIStatus("");
    try {
      const res = await api.chatAIChat(
        [{ role: "user", content: "Reply with one short sentence confirming PropAI AI is connected." }],
        doublewordKey.trim(),
        doublewordModel.trim()
      );
      setAIStatus(res.content ? "Doubleword AI responded successfully." : "Doubleword AI returned an empty response.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Doubleword AI test failed.";
      setAIStatus(message);
    } finally {
      setTestingAI(false);
    }
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <h2 className="text-lg font-bold">Settings</h2>

      {/* Doubleword AI */}
      <div className="border border-white/10 rounded-2xl p-5">
        <div className="flex items-start justify-between gap-3 mb-4">
          <div>
            <h3 className="text-sm font-bold text-white">Doubleword AI</h3>
            <div className="text-xs text-zinc-500 mt-1">
              Used by AI Chat and optional promotion copy enhancement.
            </div>
          </div>
          <span className={`badge ${doublewordKey || aiConfig?.has_server_key ? "badge-green" : "badge-gray"}`}>
            {doublewordKey ? "Browser key" : aiConfig?.has_server_key ? "Server key" : "No key"}
          </span>
        </div>

        <label className="block mb-3">
          <span className="mb-1 block text-[10px] text-zinc-500 uppercase tracking-wider">API key</span>
          <input
            type="password"
            value={doublewordKey}
            onChange={(event) => setDoublewordKey(event.target.value)}
            placeholder={aiConfig?.has_server_key ? "Server key configured; paste here to override in this browser" : "Paste Doubleword API key"}
            className="w-full rounded-lg border border-white/10 bg-zinc-800 px-3 py-2 text-sm text-white outline-none focus:border-[#3EE88A]"
          />
        </label>

        <label className="block mb-3">
          <span className="mb-1 block text-[10px] text-zinc-500 uppercase tracking-wider">Model</span>
          <input
            type="text"
            value={doublewordModel}
            onChange={(event) => setDoublewordModel(event.target.value)}
            placeholder={aiConfig?.model || "Qwen/Qwen3.6-35B-A3B-FP8"}
            className="w-full rounded-lg border border-white/10 bg-zinc-800 px-3 py-2 text-sm text-white outline-none focus:border-[#3EE88A]"
          />
          <span className="mt-1 block text-xs text-zinc-500">
            Leave blank to use the server default. Use the exact Doubleword model your key is allowed to access.
          </span>
        </label>

        <div className="flex flex-wrap gap-2">
          <button onClick={saveDoublewordKey} className="px-4 py-2 bg-[#3EE88A] text-black rounded-lg text-sm font-bold">Save Settings</button>
          <button onClick={clearDoublewordKey} className="px-4 py-2 bg-zinc-800 border border-white/10 rounded-lg text-sm">Clear</button>
          <button
            onClick={testDoublewordKey}
            disabled={testingAI || (!doublewordKey.trim() && !aiConfig?.has_server_key)}
            className="px-4 py-2 bg-zinc-800 border border-white/10 rounded-lg text-sm disabled:opacity-40"
          >
            {testingAI ? "Testing..." : "Test AI"}
          </button>
        </div>

        <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
          <div>
            <div className="text-[10px] text-zinc-500 uppercase tracking-wider">Endpoint</div>
            <div className="text-white break-all">{aiConfig?.base_url || "https://api.doubleword.ai/v1"}</div>
          </div>
          <div>
            <div className="text-[10px] text-zinc-500 uppercase tracking-wider">Model</div>
            <div className="text-white break-all">{doublewordModel || aiConfig?.model || "Qwen/Qwen3.6-35B-A3B-FP8"}</div>
          </div>
        </div>

        {aiStatus && (
          <div className="mt-3 text-xs text-zinc-400">{aiStatus}</div>
        )}
      </div>

      {/* WhatsApp Connection */}
      <div className="border border-white/10 rounded-2xl p-5">
        <h3 className="text-sm font-bold text-white mb-4">WhatsApp Connection</h3>

        <div className="flex items-center gap-2 mb-4">
          <span className={`w-2.5 h-2.5 rounded-full ${connected ? "bg-green-500" : "bg-red-500"}`} />
          <span className="text-lg font-bold">{connected ? "Connected" : "Disconnected"}</span>
        </div>
        <div className="mb-4 rounded-xl border border-white/10 bg-black/90 px-4 py-3 text-sm text-zinc-400">
          WhatsApp pairing is now terminal-only. Run <span className="font-semibold text-white">propai connect</span> in your terminal to scan the QR there. This page only shows connection status.
        </div>

        <div className="flex gap-2 mb-4">
          <button onClick={refreshConnection} className="px-4 py-2 bg-zinc-800 border border-white/10 rounded-lg text-sm">Refresh</button>
        </div>

        {/* Connection Details */}
        {connDetail && (
          <div className="mt-4 grid grid-cols-2 md:grid-cols-3 gap-3 text-sm">
            {[
              ["Device", connDetail.device_name],
              ["Phone", connDetail.phone_number],
              ["Profile", connDetail.display_name],
              ["Instance", connDetail.instance_name || connDetail.instance],
              ["Connected Since", connDetail.connected_since],
              ["Groups", connDetail.total_groups],
              ["Capture", connDetail.business_window?.label || "10 AM - 7 PM IST"],
              ["Mode", "Live webhook only"],
            ].map(([k, v]) => (
              <div key={k as string}>
                <div className="text-[10px] text-zinc-500 uppercase tracking-wider">{k as string}</div>
                <div className="text-white">{v || "—"}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Live Capture */}
      <div className="border border-white/10 rounded-2xl p-5">
        <h3 className="text-sm font-bold text-white mb-4">Live Capture</h3>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-sm">
          {[
            ["Window", "10 AM - 7 PM IST"],
            ["Mode", "Webhook only"],
            ["Backfill", "Disabled"],
          ].map(([k, v]) => (
            <div key={k}>
              <div className="text-[10px] text-zinc-500 uppercase tracking-wider">{k}</div>
              <div className="text-white">{v}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
