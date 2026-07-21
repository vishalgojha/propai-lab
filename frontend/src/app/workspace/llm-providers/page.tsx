"use client";

import React, { useState, useEffect } from "react";
import { Plus, Check, X, Play, AlertCircle, Globe, Zap } from "lucide-react";
import { fetchJSON } from "@/lib/api";

interface Provider {
  id: number;
  provider_name: string;
  provider_type: string;
  api_key: string;
  base_url: string;
  model_name: string;
  is_active: number;
}

const DEFAULT_PROVIDERS = [
  { type: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1" },
  { type: "anthropic", label: "Anthropic", baseUrl: "https://api.anthropic.com/v1" },
  { type: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1" },
  { type: "doubleword", label: "Doubleword", baseUrl: "https://api.doubleword.ai/v1" },
];

export default function LLMProvidersPage() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [activeProvider, setActiveProvider] = useState<Provider | null>(null);
  const [loading, setLoading] = useState(true);
  const [isAdding, setIsAdding] = useState(false);
  const [editingProvider, setEditingProvider] = useState<Provider | null>(null);
  const [testResult, setTestResult] = useState<{ success: boolean; latency?: number; error?: string } | null>(null);
  const [testing, setTesting] = useState(false);

  const [formData, setFormData] = useState({
    id: 0,
    provider_name: "",
    provider_type: "openai",
    api_key: "",
    base_url: "",
    model_name: "",
    is_active: false,
  });

  useEffect(() => {
    loadProviders();
  }, []);

  async function loadProviders() {
    setLoading(true);
    try {
      const [provData, activeData] = await Promise.all([
        fetchJSON<any>("/workspace/llm-providers").catch(() => ({ providers: [] })),
        fetchJSON<any>("/workspace/llm-providers/active").catch(() => null),
      ]);
      if (provData && typeof provData === "object" && provData.providers) {
        setProviders(provData.providers || []);
      } else {
        setProviders([]);
      }
      setActiveProvider(activeData && typeof activeData === "object" ? activeData : null);
    } catch (e) {
      console.error(e);
      setProviders([]);
      setActiveProvider(null);
    } finally {
      setLoading(false);
    }
  }

  async function handleSave() {
    try {
      await fetchJSON("/workspace/llm-providers", {
        method: "POST",
        body: JSON.stringify(formData),
      });
      setIsAdding(false);
      setEditingProvider(null);
      loadProviders();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Error saving provider");
    }
  }

  async function handleTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const data = await fetchJSON<any>("/workspace/llm-providers/test", {
        method: "POST",
        body: JSON.stringify({
          provider_name: formData.provider_name || editingProvider?.provider_name,
          provider_type: formData.provider_type || editingProvider?.provider_type || editingProvider?.provider_name,
          api_key: formData.api_key || editingProvider?.api_key,
          base_url: formData.base_url || editingProvider?.base_url,
          model_name: formData.model_name || editingProvider?.model_name,
        }),
      });
      if (data && typeof data === "object") {
        setTestResult(data as { success: boolean; latency?: number; error?: string });
      } else {
        setTestResult({ success: false, error: "Invalid response" });
      }
    } catch (e) {
      setTestResult({ success: false, error: String(e) });
    } finally {
      setTesting(false);
    }
  }

  async function handleActivate(provider: Provider) {
    try {
      const { api_key, ...rest } = provider;
      await fetchJSON("/workspace/llm-providers", {
        method: "POST",
        body: JSON.stringify({ ...rest, id: provider.id, is_active: true, api_key: "" }),
      });
      loadProviders();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Error activating provider");
    }
  }

  async function handleDelete(provider: Provider) {
    const ok = window.confirm(`Delete provider "${provider.provider_name}"?`);
    if (!ok) return;
    try {
      await fetchJSON(`/workspace/llm-providers/${provider.id}`, {
        method: "DELETE",
      });
      if (editingProvider?.id === provider.id) {
        setEditingProvider(null);
      }
      loadProviders();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Error deleting provider");
    }
  }

  const openAddModal = () => {
    setFormData({
      id: 0,
      provider_name: "",
      provider_type: "openai",
      api_key: "",
      base_url: DEFAULT_PROVIDERS[0].baseUrl,
      model_name: "",
      is_active: false,
    });
    setEditingProvider(null);
    setIsAdding(true);
    setTestResult(null);
  };

  const openEditModal = (provider: Provider) => {
    setFormData({
      id: provider.id,
      provider_name: provider.provider_name,
      provider_type: provider.provider_type || provider.provider_name,
      api_key: "", // Don't pre-fill key for security
      base_url: provider.base_url || DEFAULT_PROVIDERS.find((d) => d.type === (provider.provider_type || provider.provider_name))?.baseUrl || "",
      model_name: provider.model_name || "",
      is_active: !!provider.is_active,
    });
    setEditingProvider(provider);
    setIsAdding(false);
    setTestResult(null);
  };

  const activeProviderName = activeProvider?.provider_name ? String(activeProvider.provider_name).toUpperCase() : "";
  const activeProviderType = activeProvider?.provider_type ? String(activeProvider.provider_type).toUpperCase() : "";

  if (loading) return <div className="p-8 text-gray-400">Loading providers...</div>;

  return (
    <div className="p-8 max-w-5xl mx-auto">
      <div className="flex justify-between items-center mb-8">
        <div>
          <h1 className="text-2xl font-bold text-white">LLM Providers & Keys</h1>
          <p className="text-gray-400 text-sm">Manage API keys and switch between inference providers</p>
        </div>
        <button
          onClick={openAddModal}
          className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
        >
          <Plus size={16} /> Add Provider
        </button>
      </div>

      {/* Active Provider Banner */}
      {activeProviderName && (
        <div className="mb-6 p-4 bg-green-900/20 border border-green-500/30 rounded-xl flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-green-500/20 flex items-center justify-center text-green-400">
              <Zap size={20} />
            </div>
            <div>
              <div className="text-white font-semibold">
                Active Provider: {activeProviderName}
                {activeProviderType ? <span className="text-green-400"> {" "}({activeProviderType})</span> : null}
              </div>
              <div className="text-green-400 text-xs">Model: {activeProvider?.model_name || "—"}</div>
            </div>
          </div>
          <div className="text-green-400 text-sm font-medium">● Connected</div>
        </div>
      )}

      {/* Providers List */}
      <div className="bg-zinc-900 border border-white/10 rounded-xl overflow-hidden">
        <table className="w-full text-left text-sm">
          <thead className="bg-[#161b22] text-gray-400 font-medium border-b border-white/10">
            <tr>
              <th className="px-4 py-3">Provider</th>
              <th className="px-4 py-3">Type</th>
              <th className="px-4 py-3">Model</th>
              <th className="px-4 py-3">Base URL</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[rgba(255,255,255,0.04)]">
            {providers.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-gray-500">
                  No providers configured. Click Add Provider to get started.
                </td>
              </tr>
            ) : (
              providers.map((p) => (
                <tr key={p.id} className="hover:bg-white/5 transition-colors">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <div className={`w-2 h-2 rounded-full ${p.is_active ? "bg-green-400" : "bg-gray-600"}`} />
                      <span className={`font-semibold ${p.is_active ? "text-white" : "text-gray-300"}`}>{p.provider_name}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-400 uppercase">{p.provider_type || p.provider_name}</td>
                  <td className="px-4 py-3 text-gray-400 text-xs font-mono">{p.model_name}</td>
                  <td className="px-4 py-3 text-gray-500 text-xs font-mono truncate max-w-xs">{p.base_url}</td>
                  <td className="px-4 py-3">
                    {p.is_active ? (
                      <span className="px-2 py-0.5 bg-green-900/30 text-green-400 rounded text-[10px] font-bold uppercase">Active</span>
                    ) : (
                      <span className="px-2 py-0.5 bg-gray-800 text-gray-500 rounded text-[10px] font-bold uppercase">Inactive</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex justify-end gap-2">
                      {!p.is_active && (
                        <button
                          onClick={() => handleActivate(p)}
                          className="px-2 py-1 bg-green-600/20 text-green-400 hover:bg-green-600/30 rounded text-xs font-medium transition-colors"
                        >
                          Activate
                        </button>
                      )}
                      <button
                        onClick={() => openEditModal(p)}
                        className="px-2 py-1 bg-blue-600/20 text-blue-400 hover:bg-blue-600/30 rounded text-xs font-medium transition-colors"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => handleDelete(p)}
                        className="px-2 py-1 bg-red-600/20 text-red-400 hover:bg-red-600/30 rounded text-xs font-medium transition-colors"
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Add/Edit Modal */}
      {(isAdding || editingProvider) && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-zinc-900 border border-white/10 rounded-2xl w-full max-w-2xl overflow-hidden shadow-2xl">
            <div className="px-6 py-4 border-b border-white/10 flex justify-between items-center">
              <h2 className="text-lg font-bold text-white">{isAdding ? "Add LLM Provider" : "Edit Provider"}</h2>
              <button onClick={() => { setIsAdding(false); setEditingProvider(null); }} className="text-gray-400 hover:text-white">
                <X size={20} />
              </button>
            </div>
            
            <div className="p-6 space-y-6">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label className="text-xs text-gray-400 font-medium">Provider Label *</label>
                  <input
                    type="text"
                    name="llm-provider-label"
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="off"
                    spellCheck={false}
                    className="w-full bg-[#161b22] border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
                    placeholder="e.g. Groq primary"
                    value={formData.provider_name}
                    onChange={(e) => setFormData({ ...formData, provider_name: e.target.value })}
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs text-gray-400 font-medium">Provider Type *</label>
                  <select
                    className="w-full bg-[#161b22] border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
                    value={formData.provider_type}
                    onChange={(e) => {
                      const val = e.target.value;
                      const def = DEFAULT_PROVIDERS.find((d) => d.type === val);
                      const isCustom = val === "custom";
                      setFormData({
                        ...formData,
                        provider_type: val,
                        base_url: isCustom ? formData.base_url : def?.baseUrl || formData.base_url,
                        model_name: formData.model_name,
                      });
                    }}
                  >
                    {DEFAULT_PROVIDERS.map((p) => (
                      <option key={p.type} value={p.type}>{p.label}</option>
                    ))}
                    <option value="custom">CUSTOM</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label className="text-xs text-gray-400 font-medium">API Key *</label>
                  <input
                    type="password"
                    name="llm-provider-api-key"
                    autoComplete="new-password"
                    autoCorrect="off"
                    autoCapitalize="off"
                    spellCheck={false}
                    className="w-full bg-[#161b22] border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
                    placeholder={editingProvider ? "Re-enter API key to update (leave blank to keep existing)" : "Enter API key"}
                    value={formData.api_key}
                    onChange={(e) => setFormData({ ...formData, api_key: e.target.value })}
                  />
                  {!formData.api_key && editingProvider && (
                    <div className="text-[10px] text-amber-400 mt-1">
                      ⚠ Leave blank to keep saved key (masked for security). Enter a new key to replace it.
                    </div>
                  )}
                </div>
                <div className="space-y-1">
                  <label className="text-xs text-gray-400 font-medium">Base URL</label>
                  <input
                    type="text"
                    name="llm-provider-base-url"
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="off"
                    spellCheck={false}
                    className="w-full bg-[#161b22] border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 font-mono"
                    placeholder="https://api.example.com/v1"
                    value={formData.base_url}
                    onChange={(e) => setFormData({ ...formData, base_url: e.target.value })}
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label className="text-xs text-gray-400 font-medium">Default Model</label>
                  <input
                    type="text"
                    name="llm-provider-model"
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="off"
                    spellCheck={false}
                    className="w-full bg-[#161b22] border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 font-mono"
                    placeholder="model-name"
                    value={formData.model_name}
                    onChange={(e) => setFormData({ ...formData, model_name: e.target.value })}
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs text-gray-400 font-medium">Save Scope</label>
                  <div className="text-xs text-gray-500 leading-relaxed">
                    Multiple rows can use the same provider type. Give each one a distinct label.
                  </div>
                </div>
              </div>

              {/* Test Connection */}
              <div className="p-4 bg-[#161b22] rounded-lg border border-[rgba(255,255,255,0.05)]">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                    <Globe size={14} /> Test Connection
                  </h3>
                  <button
                    onClick={handleTest}
                    disabled={testing || !formData.api_key}
                    className="flex items-center gap-2 px-3 py-1.5 bg-blue-600/20 text-blue-400 hover:bg-blue-600/30 rounded text-xs font-medium disabled:opacity-50"
                  >
                    <Play size={12} /> {testing ? "Testing..." : "Test"}
                  </button>
                </div>
                {testResult && (
                  <div className={`text-xs p-2 rounded ${testResult.success ? "bg-green-900/20 text-green-400" : "bg-red-900/20 text-red-400"}`}>
                    {testResult.success ? (
                      <div className="flex items-center gap-2">
                        <Check size={12} /> Connected in {testResult.latency}s
                      </div>
                    ) : (
                      <div className="flex items-center gap-2">
                        <AlertCircle size={12} /> {testResult.error}
                      </div>
                    )}
                  </div>
                )}
              </div>

              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="is_active"
                  className="rounded border-gray-700 bg-gray-900 text-blue-600 focus:ring-0"
                  checked={formData.is_active}
                  onChange={(e) => setFormData({ ...formData, is_active: e.target.checked })}
                />
                <label htmlFor="is_active" className="text-sm text-gray-300">
                  Set as active provider (will replace current active)
                </label>
              </div>
            </div>

            <div className="px-6 py-4 bg-[#161b22] border-t border-white/10 flex justify-end gap-3">
              <button
                onClick={() => setIsAdding(false)}
                className="px-4 py-2 text-sm font-medium text-gray-400 hover:text-white transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={
                  !formData.provider_name ||
                  (isAdding && !formData.api_key?.trim())
                }
                className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {isAdding ? "Add Provider" : "Save Changes"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
