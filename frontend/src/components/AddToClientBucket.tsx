"use client";

import React, { useState, useEffect } from "react";
import { motion, useReducedMotion } from "framer-motion";
import Drawer from "@/components/motion/Drawer";
import { fetchJSON } from "@/lib/api";

interface Client {
  id: number;
  name: string;
  phone?: string;
}

interface Requirement {
  id: number;
  intent: string;
  bhk?: string;
  price_min?: number;
  price_max?: number;
  micro_market?: string;
  area_sqft_min?: number;
  area_sqft_max?: number;
}

interface MatchResult {
  requirement: Requirement & { client_name: string; client_phone?: string };
  score: number;
  breakdown: Record<string, { match: boolean | string; score: number }>;
}

interface AddToClientBucketProps {
  isOpen: boolean;
  onClose: () => void;
  selectedText: string;
  messageContext?: any;
  onSave: (clientId: number, notes: string) => void;
}

export default function AddToClientBucket({
  isOpen,
  onClose,
  selectedText,
  messageContext,
  onSave,
}: AddToClientBucketProps) {
  const reduceMotion = useReducedMotion();
  const [step, setStep] = useState<"select" | "match" | "confirm">("select");
  const [clients, setClients] = useState<Client[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedClient, setSelectedClient] = useState<Client | null>(null);
  const [matches, setMatches] = useState<MatchResult[]>([]);
  const [selectedMatch, setSelectedMatch] = useState<MatchResult | null>(null);
  const [notes, setNotes] = useState("");
  const [loading, setLoading] = useState(false);
  const [newClientName, setNewClientName] = useState("");
  const [showNewClient, setShowNewClient] = useState(false);

  useEffect(() => {
    if (isOpen) {
      fetchClients();
      setStep("select");
      setSelectedClient(null);
      setMatches([]);
      setSelectedMatch(null);
      setNotes("");
    }
  }, [isOpen]);

  const fetchClients = async () => {
    try {
      const data = await fetchJSON<Client[]>(`/clients?q=${searchQuery}`);
      setClients(data);
    } catch (e) {
      console.error("Failed to fetch clients:", e);
    }
  };

  useEffect(() => {
    fetchClients();
  }, [searchQuery]);

  const handleSelectClient = async (client: Client) => {
    setSelectedClient(client);
    setStep("match");
    setLoading(true);

    try {
      // Run matching against client's requirements
      const data = await fetchJSON<any>("/clients/match", {
        method: "POST",
        body: JSON.stringify({
          price: messageContext?.price,
          bhk: messageContext?.bhk,
          micro_market: messageContext?.micro_market,
          area_sqft: messageContext?.area_sqft,
          building_name: messageContext?.building_name,
          furnishing: messageContext?.furnishing,
          intent: messageContext?.intent,
        }),
      });
      setMatches(data.matches || []);
      setStep("confirm");
    } catch (e) {
      console.error("Match failed:", e);
      setStep("confirm");
    } finally {
      setLoading(false);
    }
  };

  const handleCreateClient = async () => {
    if (!newClientName.trim()) return;
    try {
      const data = await fetchJSON<any>("/clients", {
        method: "POST",
        body: JSON.stringify({ name: newClientName }),
      });
      const newClient = { id: data.id, name: newClientName };
      setClients([newClient, ...clients]);
      setSelectedClient(newClient);
      setShowNewClient(false);
      setNewClientName("");
      handleSelectClient(newClient);
    } catch (e) {
      console.error("Failed to create client:", e);
    }
  };

  const handleSave = async () => {
    if (!selectedClient) return;
    setLoading(true);
    try {
      await fetchJSON(`/clients/${selectedClient.id}/candidates`, {
        method: "POST",
        body: JSON.stringify({
          message_id: messageContext?.id,
          building_name: messageContext?.building_name,
          micro_market: messageContext?.micro_market,
          bhk: messageContext?.bhk,
          price: messageContext?.price,
          area_sqft: messageContext?.area_sqft,
          furnishing: messageContext?.furnishing,
          confidence: selectedMatch?.score || 0,
          match_breakdown: selectedMatch?.breakdown || {},
          source_text: selectedText,
          notes,
        }),
      });
      onSave(selectedClient.id, notes);
      onClose();
    } catch (e) {
      console.error("Failed to save:", e);
    } finally {
      setLoading(false);
    }
  };

  if (!isOpen) return null;

  return (
    <Drawer open={isOpen} onClose={onClose} variant="center" panelClass="bg-[#0a0f14] border border-white/10 shadow-2xl">
      <div className="w-full">
        {/* Header */}
        <div className="p-5 border-b border-white/10">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-bold text-white">Add to Client Bucket</h2>
            <button onClick={onClose} className="text-zinc-500 hover:text-white text-lg">×</button>
          </div>
          <p className="text-[11px] text-zinc-500 mt-1 truncate">
            &quot;{selectedText.slice(0, 80)}...&quot;
          </p>
        </div>

        {/* Step: Select Client */}
        {step === "select" && (
          <div className="p-5">
            <input
              type="text"
              placeholder="Search clients..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full px-3 py-2 bg-zinc-800 border border-white/10 rounded-lg text-xs text-white placeholder-[#4a5568] focus:outline-none focus:border-blue-500 mb-3"
            />

            <div className="max-h-48 overflow-y-auto space-y-1">
              {clients.map((client) => (
                <button
                  key={client.id}
                  onClick={() => handleSelectClient(client)}
                  className="w-full text-left px-3 py-2 rounded-lg hover:bg-[rgba(255,255,255,0.05)] flex items-center justify-between group"
                >
                  <div>
                    <div className="text-xs font-semibold text-white">{client.name}</div>
                    {client.phone && (
                      <div className="text-[10px] text-zinc-500">{client.phone}</div>
                    )}
                  </div>
                  <span className="text-[10px] text-blue-400 opacity-0 group-hover:opacity-100">Select →</span>
                </button>
              ))}
            </div>

            <div className="mt-3 pt-3 border-t border-white/10">
              {showNewClient ? (
                <div className="flex gap-2">
                  <input
                    type="text"
                    placeholder="Client name"
                    value={newClientName}
                    onChange={(e) => setNewClientName(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleCreateClient()}
                    className="flex-1 px-3 py-2 bg-zinc-800 border border-white/10 rounded-lg text-xs text-white placeholder-[#4a5568] focus:outline-none focus:border-blue-500"
                    autoFocus
                  />
                  <button
                    onClick={handleCreateClient}
                    className="px-3 py-2 bg-blue-600 text-white text-xs font-bold rounded-lg hover:bg-blue-500"
                  >
                    Create
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setShowNewClient(true)}
                  className="text-xs text-blue-400 hover:text-[#60a5fa]"
                >
                  + Create New Client
                </button>
              )}
            </div>
          </div>
        )}

        {/* Step: Matching */}
        {step === "match" && loading && (
          <div className="p-10 text-center">
            <div className="text-2xl mb-2">🔍</div>
            <div className="text-xs text-zinc-500">Running AI compatibility analysis...</div>
          </div>
        )}

        {/* Step: Confirm */}
        {step === "confirm" && (
          <div className="p-5">
            {/* Selected Client */}
            <div className="bg-zinc-800 rounded-lg p-3 mb-4">
              <div className="text-[10px] text-zinc-500 uppercase tracking-wider font-bold mb-1">Client</div>
              <div className="text-xs font-semibold text-white">{selectedClient?.name}</div>
            </div>

            {/* Property Info */}
            {messageContext && (
              <div className="grid grid-cols-2 gap-3 mb-4">
                {messageContext.building_name && (
                  <div className="bg-zinc-800 rounded-lg p-2.5">
                    <div className="text-[9px] text-zinc-500 uppercase">Building</div>
                    <div className="text-[11px] text-white font-medium">{messageContext.building_name}</div>
                  </div>
                )}
                {messageContext.micro_market && (
                  <div className="bg-zinc-800 rounded-lg p-2.5">
                    <div className="text-[9px] text-zinc-500 uppercase">Location</div>
                    <div className="text-[11px] text-white font-medium">{messageContext.micro_market}</div>
                  </div>
                )}
                {messageContext.bhk && (
                  <div className="bg-zinc-800 rounded-lg p-2.5">
                    <div className="text-[9px] text-zinc-500 uppercase">BHK</div>
                    <div className="text-[11px] text-white font-medium">{messageContext.bhk}</div>
                  </div>
                )}
                {messageContext.price && (
                  <div className="bg-zinc-800 rounded-lg p-2.5">
                    <div className="text-[9px] text-zinc-500 uppercase">Price</div>
                    <div className="text-[11px] text-white font-medium">
                      ₹{(messageContext.price / 100000).toFixed(1)}L
                    </div>
                  </div>
                )}
                {messageContext.area_sqft && (
                  <div className="bg-zinc-800 rounded-lg p-2.5">
                    <div className="text-[9px] text-zinc-500 uppercase">Area</div>
                    <div className="text-[11px] text-white font-medium">{messageContext.area_sqft} sqft</div>
                  </div>
                )}
                {messageContext.furnishing && (
                  <div className="bg-zinc-800 rounded-lg p-2.5">
                    <div className="text-[9px] text-zinc-500 uppercase">Furnishing</div>
                    <div className="text-[11px] text-white font-medium">{messageContext.furnishing}</div>
                  </div>
                )}
              </div>
            )}

            {/* Compatibility Score */}
            {matches.length > 0 && (
              <div className="mb-4">
                <div className="text-[10px] text-zinc-500 uppercase tracking-wider font-bold mb-2">
                  Best Match: {matches[0].requirement.client_name}
                </div>
                <div className="bg-zinc-800 rounded-lg p-3">
                  <div className="flex items-center gap-3 mb-2">
                    <div className={`text-2xl font-bold ${matches[0].score >= 80 ? "text-green-400" : matches[0].score >= 60 ? "text-yellow-400" : "text-red-400"}`}>
                      {matches[0].score}%
                    </div>
                    <div className="text-xs text-zinc-400">Compatibility</div>
                  </div>
                  <div className="grid grid-cols-2 gap-1.5">
                    {Object.entries(matches[0].breakdown).map(([key, val]) => (
                      <div key={key} className="flex items-center gap-1.5 text-[10px]">
                        <span className={val.match === true ? "text-green-400" : val.match === "close" || val.match === "partial" ? "text-yellow-400" : "text-red-400"}>
                          {val.match === true ? "✓" : val.match === "close" || val.match === "partial" ? "~" : "✗"}
                        </span>
                        <span className="text-zinc-400 capitalize">{key}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* Notes */}
            <textarea
              placeholder="Add notes (optional)..."
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="w-full px-3 py-2 bg-zinc-800 border border-white/10 rounded-lg text-xs text-white placeholder-[#4a5568] focus:outline-none focus:border-blue-500 resize-none h-16 mb-4"
            />

            {/* Actions */}
            <div className="flex gap-2">
              <button
                onClick={onClose}
                className="flex-1 px-4 py-2.5 bg-[#1e293b] text-zinc-400 text-xs font-bold rounded-lg hover:bg-[#2d3748] transition-colors"
              >
                Cancel
              </button>
              <motion.button
                onClick={handleSave}
                disabled={loading}
                whileHover={reduceMotion ? undefined : { scale: 1.02 }}
                whileTap={reduceMotion ? undefined : { scale: 0.98 }}
                className="flex-1 px-4 py-2.5 bg-blue-600 text-white text-xs font-bold rounded-lg hover:bg-blue-500 transition-colors disabled:opacity-50"
              >
                {loading ? "Saving..." : "Save to Bucket"}
              </motion.button>
            </div>
          </div>
        )}
      </div>
    </Drawer>
  );
}
