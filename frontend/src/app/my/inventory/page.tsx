"use client";

import { useEffect, useState } from "react";
import * as api from "@/lib/api";
import { Building2, MapPin, Users, ArrowUpRight, Save } from "lucide-react";

export default function MarketInventoryPage() {
  const [listings, setListings] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.getMyInventory(200).then((data) => {
      setListings(data || []);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  return (
    <div className="max-w-5xl">
      <div className="flex items-end justify-between">
        <div>
          <h2 className="text-lg font-bold text-[#e2e8f0]">My Inventory</h2>
          <p className="mt-1 text-sm text-[#64748b]">Saved inventory mapped to your active clients.</p>
        </div>
        <button className="rounded-lg bg-[#111820] border border-[rgba(255,255,255,0.08)] px-4 py-2 text-sm text-[#e2e8f0] hover:bg-[#1a2332] transition-colors">
          + Log Listing
        </button>
      </div>

      {loading ? (
        <div className="mt-6 rounded-2xl border border-[rgba(255,255,255,0.06)] bg-[#0d1117] p-8 text-center text-sm text-[#64748b]">
          Loading your inventory...
        </div>
      ) : listings.length === 0 ? (
        <div className="mt-6 rounded-2xl border border-[rgba(255,255,255,0.06)] bg-[#0d1117] p-8 text-center">
          <div className="text-sm font-semibold text-[#e2e8f0]">No saved inventory yet.</div>
          <div className="mx-auto mt-2 max-w-xl text-sm text-[#64748b]">
            Save listings to a client bucket from inbox actions to see them here.
          </div>
        </div>
      ) : (
        <div className="mt-6 space-y-2">
          {listings.map((listing: any) => (
            <div key={listing.id} className="rounded-xl border border-[rgba(255,255,255,0.06)] bg-[#0d1117] p-4 hover:border-[rgba(255,255,255,0.12)] transition-colors">
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 text-[10px] text-[#64748b]">
                    <span className="badge badge-blue text-[8px]">MY INVENTORY</span>
                    <span>Client</span>
                    <span className="text-[#cbd5e1] font-semibold">{listing.client_name || "Unknown Client"}</span>
                    {listing.client_phone && (
                      <span className="font-mono">{listing.client_phone}</span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 text-xs text-[#64748b] mt-1">
                    <Building2 className="w-3 h-3" strokeWidth={1.5} />
                    <span className="text-[#cbd5e1] font-semibold">{listing.building_name || "Unknown Building"}</span>
                    {listing.micro_market && (
                      <span className="flex items-center gap-1"><MapPin className="w-2.5 h-2.5" strokeWidth={1.5} />{listing.micro_market}</span>
                    )}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {listing.intent && <span className="badge badge-blue text-[9px]">{listing.intent}</span>}
                    {listing.bhk && <span className="badge badge-purple text-[9px]">{listing.bhk}</span>}
                    {listing.price && <span className="badge badge-green text-[9px]">₹{listing.price} {listing.price_unit || ""}</span>}
                    {listing.area_sqft && <span className="badge text-[9px] bg-[rgba(255,255,255,0.05)] text-[#94a3b8]">{listing.area_sqft} sqft</span>}
                    {listing.furnishing && <span className="badge text-[9px] bg-[rgba(255,255,255,0.05)] text-[#94a3b8]">{listing.furnishing}</span>}
                  </div>
                  {(listing.confidence ?? 0) > 0 && (
                    <div className="mt-1.5 flex items-center gap-1 text-[10px] text-[#64748b]">
                      <Users className="w-2.5 h-2.5" strokeWidth={1.5} />
                      Match confidence {(listing.confidence ?? 0).toFixed(0)}%
                    </div>
                  )}
                </div>
                <div className="flex gap-1 shrink-0">
                  <button className="p-2 rounded-lg hover:bg-[rgba(255,255,255,0.05)] text-[#64748b] hover:text-[#3EE88A] transition-colors" title="Save to My Workspace">
                    <Save className="w-4 h-4" strokeWidth={1.5} />
                  </button>
                  <button className="p-2 rounded-lg hover:bg-[rgba(255,255,255,0.05)] text-[#64748b] hover:text-white transition-colors" title="View details">
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
