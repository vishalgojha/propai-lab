"use client";

import { useEffect, useState } from "react";
import * as api from "@/lib/api";
import { User, MapPin, ArrowUpRight, Save } from "lucide-react";

export default function MarketRequirementsPage() {
  const [requirements, setRequirements] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.getMyRequirements(200).then((data) => {
      setRequirements(data || []);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  return (
    <div className="max-w-5xl">
      <div className="flex items-end justify-between">
        <div>
          <h2 className="text-lg font-bold text-white">My Requirements</h2>
          <p className="mt-1 text-sm text-zinc-500">Requirements from your active clients only.</p>
        </div>
        <button className="rounded-lg bg-zinc-800 border border-white/10 px-4 py-2 text-sm text-white hover:bg-[#1a2332] transition-colors">
          + Log Requirement
        </button>
      </div>

      {loading ? (
        <div className="mt-6 rounded-2xl border border-white/10 bg-zinc-900 p-8 text-center text-sm text-zinc-500">
          Loading your requirements...
        </div>
      ) : requirements.length === 0 ? (
        <div className="mt-6 rounded-2xl border border-white/10 bg-zinc-900 p-8 text-center">
          <div className="text-sm font-semibold text-white">No active-client requirements yet.</div>
          <div className="mx-auto mt-2 max-w-xl text-sm text-zinc-500">
            Add requirements for your clients and they will show up here.
          </div>
        </div>
      ) : (
        <div className="mt-6 space-y-2">
          {requirements.map((req: any) => (
            <div key={req.id} className="rounded-xl border border-white/10 bg-zinc-900 p-4 hover:border-white/10 transition-colors">
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 text-[10px] text-zinc-500">
                    <span className="badge badge-purple text-[8px]">MY REQUIREMENT</span>
                    <span>Client</span>
                    <span className="text-zinc-300 font-semibold">{req.client_name || "Unknown Client"}</span>
                  </div>
                  <div className="flex items-center gap-2 text-xs text-zinc-500 mt-1">
                    <User className="w-3 h-3" strokeWidth={1.5} />
                    <span className="text-zinc-300 font-semibold">{req.intent || "BUY"}</span>
                    {req.client_phone && (
                      <>
                        <span>•</span>
                        <span className="font-mono">{req.client_phone}</span>
                      </>
                    )}
                    {req.created_at && (
                      <>
                        <span>•</span>
                        <span>{new Date(req.created_at).toLocaleDateString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
                      </>
                    )}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {req.intent && <span className="badge badge-purple text-[9px]">{req.intent}</span>}
                    {req.bhk && <span className="badge badge-blue text-[9px]">{req.bhk}</span>}
                    {req.price && req.price_unit && <span className="badge badge-green text-[9px]">₹{req.price} {req.price_unit}</span>}
                    {req.area_sqft && <span className="badge text-[9px] bg-[rgba(255,255,255,0.05)] text-zinc-400">{req.area_sqft} sqft</span>}
                  </div>
                  {req.location_raw && (
                    <div className="mt-1.5 flex items-center gap-1 text-[10px] text-zinc-500">
                      <MapPin className="w-2.5 h-2.5" strokeWidth={1.5} />
                      {req.location_raw}
                    </div>
                  )}
                </div>
                <div className="flex gap-1 shrink-0">
                  <button className="p-2 rounded-lg hover:bg-[rgba(255,255,255,0.05)] text-zinc-500 hover:text-[#3EE88A] transition-colors" title="Save to My Workspace">
                    <Save className="w-4 h-4" strokeWidth={1.5} />
                  </button>
                  <button className="p-2 rounded-lg hover:bg-[rgba(255,255,255,0.05)] text-zinc-500 hover:text-white transition-colors" title="View details">
                    <ArrowUpRight className="w-4 h-4" strokeWidth={1.5} />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
