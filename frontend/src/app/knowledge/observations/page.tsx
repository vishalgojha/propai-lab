"use client";

import { useEffect, useState } from "react";
import { fetchJSON } from "@/lib/api";

const copyToClipboard = async (text: string): Promise<boolean> => {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
};

interface KnowledgeObservation {
  id: number;
  entity_type: string;
  entity_name: string;
  observation_type: string;
  observation_text: string;
  confidence: number;
  observation_count: number;
  source_broker_name: string | null;
  source_broker_phone: string | null;
  created_at: string;
  updated_at: string;
}

interface Stats {
  total: number;
  by_type: Array<{ observation_type: string; c: number }>;
  by_entity_type: Array<{ entity_type: string; c: number }>;
  top_entities: Array<{ entity_name: string; entity_type: string; c: number; conf: number }>;
}

export default function KnowledgeObservationsPage() {
  const [observations, setObservations] = useState<KnowledgeObservation[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [entityTypeFilter, setEntityTypeFilter] = useState("");
  const [entityNameFilter, setEntityNameFilter] = useState("");
  const [brokerPhoneFilter, setBrokerPhoneFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<KnowledgeObservation | null>(null);
  const [entityTypes, setEntityTypes] = useState<string[]>([]);
  const [copyToast, setCopyToast] = useState(false);

  const fetchData = async () => {
    const params = new URLSearchParams();
    if (entityTypeFilter) params.set("entity_type", entityTypeFilter);
    if (entityNameFilter) params.set("entity_name", entityNameFilter);
    if (brokerPhoneFilter) params.set("broker_phone", brokerPhoneFilter);
    params.set("limit", "100");

    const [obsData, statsData] = await Promise.all([
      fetchJSON<KnowledgeObservation[]>(`/knowledge/observations?${params.toString()}`),
      fetchJSON<Stats>("/knowledge/observations/stats"),
    ]);
    setObservations(obsData);
    setStats(statsData);
    setLoading(false);

    // Extract unique entity types for filter dropdown
    const types = Array.from(new Set(obsData.map(o => o.entity_type)));
    setEntityTypes(types);
  };

  useEffect(() => {
    fetchData();
  }, [entityTypeFilter, entityNameFilter, brokerPhoneFilter]);

  const getConfidenceColor = (confidence: number) => {
    if (confidence >= 5) return "bg-green-800 text-green-200";
    if (confidence >= 3) return "bg-amber-800 text-amber-200";
    return "bg-red-800 text-red-200";
  };

  const getEntityTypeColor = (type: string) => {
    switch (type) {
      case "building": return "bg-blue-900/30 border-blue-800/50";
      case "wing": return "bg-purple-900/30 border-purple-800/50";
      case "tower": return "bg-indigo-900/30 border-indigo-800/50";
      case "stack": return "bg-cyan-900/30 border-cyan-800/50";
      case "flat": return "bg-teal-900/30 border-teal-800/50";
      case "locality": return "bg-green-900/30 border-green-800/50";
      case "builder": return "bg-amber-900/30 border-amber-800/50";
      case "project": return "bg-orange-900/30 border-orange-800/50";
      default: return "bg-zinc-900 border-zinc-800";
    }
  };

  const getObservationTypeColor = (type: string) => {
    switch (type) {
      case "building_feedback": return "bg-blue-800/50 text-blue-200";
      case "client_preference": return "bg-purple-800/50 text-purple-200";
      case "price_feedback": return "bg-green-800/50 text-green-200";
      case "amenity_feedback": return "bg-amber-800/50 text-amber-200";
      case "construction_feedback": return "bg-orange-800/50 text-orange-200";
      case "maintenance_feedback": return "bg-red-800/50 text-red-200";
      case "location_feedback": return "bg-teal-800/50 text-teal-200";
      case "broker_feedback": return "bg-pink-800/50 text-pink-200";
      default: return "bg-zinc-800/50 text-zinc-200";
    }
  };

  if (loading) {
    return (
      <div className="max-w-6xl mx-auto p-6">
        <div className="text-center py-12 text-zinc-500">Loading observations...</div>
      </div>
    );
  }

  const total = stats?.total ?? 0;
  const byType = stats?.by_type ?? [];
  const byEntityType = stats?.by_entity_type ?? [];
  const topEntities = stats?.top_entities ?? [];

  return (
    <div className="max-w-6xl mx-auto p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Knowledge Observations</h1>
        <p className="text-sm text-zinc-500 mt-1">
          {total.toLocaleString()} extracted observations from broker conversations
        </p>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
          <div className="text-3xl font-bold text-white">{total.toLocaleString()}</div>
          <div className="text-xs text-zinc-400">Total Observations</div>
        </div>
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
          <div className="text-3xl font-bold text-blue-400">{byType.length}</div>
          <div className="text-xs text-zinc-400">Observation Types</div>
        </div>
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
          <div className="text-3xl font-bold text-purple-400">{byEntityType.length}</div>
          <div className="text-xs text-zinc-400">Entity Types</div>
        </div>
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
          <div className="text-3xl font-bold text-green-400">{topEntities.length}</div>
          <div className="text-xs text-zinc-400">Top Entities</div>
        </div>
      </div>

      {/* Breakdown Stats */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
          <h3 className="font-semibold mb-2 text-zinc-300">By Observation Type</h3>
          <div className="space-y-1">
            {byType.slice(0, 10).map((t) => (
              <div key={t.observation_type} className="flex justify-between text-sm">
                <span className="text-zinc-300 capitalize">{t.observation_type.replace(/_/g, " ")}</span>
                <span className="font-mono text-white">{t.c}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
          <h3 className="font-semibold mb-2 text-zinc-300">By Entity Type</h3>
          <div className="space-y-1">
            {byEntityType.map((t) => (
              <div key={t.entity_type} className="flex justify-between text-sm">
                <span className="text-zinc-300 capitalize">{t.entity_type}</span>
                <span className="font-mono text-white">{t.c}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 mb-6">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div>
            <label className="block text-xs text-zinc-400 mb-1">Entity Type</label>
            <select
              value={entityTypeFilter}
              onChange={(e) => setEntityTypeFilter(e.target.value)}
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-zinc-500"
            >
              <option value="">All Types</option>
              {entityTypes.map((t) => (
                <option key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-zinc-400 mb-1">Entity Name Search</label>
            <input
              type="text"
              value={entityNameFilter}
              onChange={(e) => setEntityNameFilter(e.target.value)}
              placeholder="Search entity name..."
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-zinc-500"
            />
          </div>
          <div>
            <label className="block text-xs text-zinc-400 mb-1">Broker Phone</label>
            <input
              type="text"
              value={brokerPhoneFilter}
              onChange={(e) => setBrokerPhoneFilter(e.target.value)}
              placeholder="Filter by broker phone..."
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-zinc-500"
            />
          </div>
        </div>
      </div>

      {/* Top Entities */}
      {topEntities.length > 0 && (
        <div className="rounded-lg border border-white/10 p-4 mb-6">
          <h3 className="font-semibold mb-3 text-zinc-300">Top Entities by Observation Count</h3>
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-2">
            {topEntities.slice(0, 15).map((e) => (
              <div key={`${e.entity_name}-${e.entity_type}`} className="p-3">
                <div className="font-medium text-sm truncate" title={e.entity_name}>
                  {e.entity_name}
                </div>
                <div className="flex items-center gap-1 mt-1">
                  <span className="text-xs text-zinc-500 capitalize">{e.entity_type}</span>
                  <span className="text-xs text-zinc-400">·</span>
                  <span className="text-xs font-mono text-white">{e.c} obs</span>
                  <span className="text-xs text-zinc-400">·</span>
                  <span className={`text-xs px-1.5 py-0.5 rounded ${getConfidenceColor(e.conf)}`}>
                    Conf: {e.conf}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Observations List */}
      <div className="space-y-2">
        {observations.length === 0 ? (
          <div className="text-center py-12 text-zinc-500">No observations found</div>
        ) : (
          observations.map((obs) => (
            <div
              key={obs.id}
              onClick={() => setSelected(obs)}
              className={`border rounded-lg p-4 cursor-pointer hover:border-zinc-500 ${getEntityTypeColor(obs.entity_type)}`}
            >
              <div className="flex items-start justify-between">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-xs text-zinc-400">#{obs.id}</span>
                    <span className={`text-xs px-2 py-0.5 rounded ${getEntityTypeColor(obs.entity_type).replace("bg-", "bg-").replace("border-", "text-")} font-medium`}>
                      {obs.entity_type}
                    </span>
                    <span className={`text-xs px-2 py-0.5 rounded ${getObservationTypeColor(obs.observation_type)}`}>
                      {obs.observation_type.replace(/_/g, " ")}
                    </span>
                  </div>
                  <div className="text-lg font-medium text-white truncate">{obs.entity_name}</div>
                  <div className="text-sm line-clamp-2 mt-1 text-zinc-300">{obs.observation_text}</div>
                  <div className="flex items-center gap-3 mt-2 text-xs text-zinc-400">
                    {obs.source_broker_name && (
                      <span>{obs.source_broker_name}</span>
                    )}
                    {obs.source_broker_phone && (
                      <span className="font-mono">{obs.source_broker_phone}</span>
                    )}
                    <span>{obs.updated_at?.split("T")[0]}</span>
                  </div>
                </div>
                <div className="text-right">
                  <div className={`text-xs px-2 py-1 rounded ${getConfidenceColor(obs.confidence)} font-medium`}>
                    Confidence: {obs.confidence}/5
                  </div>
                  <div className="text-xs text-zinc-500 mt-1">{obs.observation_count} report{obs.observation_count !== 1 ? "s" : ""}</div>
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Detail Modal */}
      {selected && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          {copyToast && (
            <div className="fixed top-4 right-4 z-60 bg-green-900/90 text-green-200 px-4 py-2 rounded-lg text-sm font-medium shadow-lg animate-in fade-in slide-in-from-top-2">
              Copied to clipboard!
            </div>
          )}
          <div className="bg-zinc-900 rounded-xl max-w-3xl w-full max-h-[80vh] overflow-auto p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold">Observation #{selected.id}</h2>
              <button
                onClick={() => setSelected(null)}
                className="text-zinc-400 hover:text-white"
              >
                ✕
              </button>
            </div>
            <div className="space-y-4">
              <div>
                <div className="text-xs text-zinc-400 mb-1">Entity</div>
                <div className="flex items-center gap-2">
                  <span className={`text-sm px-3 py-1 rounded ${getEntityTypeColor(selected.entity_type).replace("bg-", "bg-").replace("border-", "text-")} font-medium`}>
                    {selected.entity_type}
                  </span>
                  <span className="text-lg font-medium text-white">{selected.entity_name}</span>
                </div>
              </div>

              <div>
                <div className="text-xs text-zinc-400 mb-1">Observation Type</div>
                <span className={`text-sm px-3 py-1 rounded ${getObservationTypeColor(selected.observation_type)}`}>
                  {selected.observation_type.replace(/_/g, " ")}
                </span>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs text-zinc-400">Observation Text</span>
                  <button
                    onClick={async () => {
                      const success = await copyToClipboard(selected.observation_text);
                      if (success) {
                        setCopyToast(true);
                        setTimeout(() => setCopyToast(false), 1500);
                      }
                    }}
                    className="text-xs text-zinc-500 hover:text-white transition-colors flex items-center gap-1"
                    title="Copy to clipboard"
                  >
                    📋 Copy
                  </button>
                </div>
                <div className="bg-zinc-800 rounded-lg p-3 text-sm whitespace-pre-wrap text-zinc-200 cursor-pointer hover:bg-zinc-700/50 transition-colors"
                     onClick={async () => {
                       const success = await copyToClipboard(selected.observation_text);
                       if (success) {
                         setCopyToast(true);
                         setTimeout(() => setCopyToast(false), 1500);
                       }
                     }}
                     title="Click to copy">
                  {selected.observation_text}
                </div>
              </div>

              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div>
                  <div className="text-xs text-zinc-400 mb-1">Confidence</div>
                  <div className={`text-lg font-bold ${getConfidenceColor(selected.confidence)}`}>
                    {selected.confidence}/5
                  </div>
                </div>
                <div>
                  <div className="text-xs text-zinc-400 mb-1">Report Count</div>
                  <div className="text-lg font-bold text-white">{selected.observation_count}</div>
                </div>
                <div>
                  <div className="text-xs text-zinc-400 mb-1">Source Broker</div>
                  <div className="text-sm text-zinc-300">
                    {selected.source_broker_name || "Unknown"}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-zinc-400 mb-1">Broker Phone</div>
                  <div className="text-sm font-mono text-zinc-300">
                    {selected.source_broker_phone || "Unknown"}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-zinc-400 mb-1">Created</div>
                  <div className="text-sm text-zinc-300">{selected.created_at?.split("T")[0]}</div>
                </div>
                <div>
                  <div className="text-xs text-zinc-400 mb-1">Updated</div>
                  <div className="text-sm text-zinc-300">{selected.updated_at?.split("T")[0]}</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}