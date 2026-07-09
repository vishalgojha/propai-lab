"use client";

import { useState, useEffect } from "react";
import * as api from "@/lib/api";

const YEARS = Array.from({ length: 42 }, (_, i) => 2026 - i);

export default function IGRSearchPage() {
  const [districts, setDistricts] = useState<any[]>([]);
  const [tahsils, setTahsils] = useState<any[]>([]);
  const [villages, setVillages] = useState<any[]>([]);

  const [districtCode, setDistrictCode] = useState("");
  const [tahsilCode, setTahsilCode] = useState("");
  const [village, setVillage] = useState("");
  const [propertyNo, setPropertyNo] = useState("");
  const [year, setYear] = useState(2025);

  const [results, setResults] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // Load districts on mount
  useEffect(() => {
    api.getIGRDistricts(true).then(setDistricts).catch(() => {});
  }, []);

  // Load tahsils when district changes
  useEffect(() => {
    if (!districtCode) { setTahsils([]); setTahsilCode(""); return; }
    setTahsilCode(""); setVillages([]); setVillage("");
    api.getIGRTahsils(districtCode).then(setTahsils).catch(() => {});
  }, [districtCode]);

  // Load villages when tahsil changes
  useEffect(() => {
    if (!districtCode || !tahsilCode) { setVillages([]); setVillage(""); return; }
    setVillage("");
    api.getIGRVillages(districtCode, tahsilCode).then(setVillages).catch(() => {});
  }, [districtCode, tahsilCode]);

  const handleSearch = async () => {
    if (!districtCode || !tahsilCode || !village) {
      setError("Select district, tahsil, and village");
      return;
    }

    setLoading(true);
    setError("");
    setResults(null);

    try {
      const data = await api.searchIGR({
        district_code: districtCode,
        tahsil_code: tahsilCode,
        village,
        property_no: propertyNo,
        year,
      });
      setResults(data);
    } catch (e: any) {
      setError(e.message || "Search failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold">IGR Maharashtra Search</h1>
        <p className="text-zinc-500 text-sm mt-1">
          Search property registrations by CTS/Survey number
        </p>
      </div>

      {/* Search Form */}
      <div className="bg-[#0a0f14] border border-white/10 rounded-lg p-4">
        <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
          <div>
            <label className="block text-xs text-zinc-500 mb-1">District</label>
            <select
              value={districtCode}
              onChange={(e) => setDistrictCode(e.target.value)}
              className="w-full bg-zinc-900 border border-white/10 rounded px-3 py-2 text-sm text-white"
            >
              <option value="">Select District</option>
              {districts.map((d) => (
                <option key={d.code} value={d.code}>{d.name}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs text-zinc-500 mb-1">Tahsil</label>
            <select
              value={tahsilCode}
              onChange={(e) => setTahsilCode(e.target.value)}
              disabled={!districtCode}
              className="w-full bg-zinc-900 border border-white/10 rounded px-3 py-2 text-sm text-white disabled:opacity-40"
            >
              <option value="">Select Tahsil</option>
              {tahsils.map((t) => (
                <option key={t.code} value={t.code}>{t.name}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs text-zinc-500 mb-1">Village</label>
            <select
              value={village}
              onChange={(e) => setVillage(e.target.value)}
              disabled={!tahsilCode}
              className="w-full bg-zinc-900 border border-white/10 rounded px-3 py-2 text-sm text-white disabled:opacity-40"
            >
              <option value="">Select Village</option>
              {villages.map((v) => (
                <option key={v.code} value={v.code}>{v.name}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs text-zinc-500 mb-1">Property No. (CTS/Survey)</label>
            <input
              type="text"
              value={propertyNo}
              onChange={(e) => setPropertyNo(e.target.value)}
              placeholder="e.g., 1234"
              className="w-full bg-zinc-900 border border-white/10 rounded px-3 py-2 text-sm text-white placeholder:text-zinc-500"
            />
          </div>

          <div>
            <label className="block text-xs text-zinc-500 mb-1">Year</label>
            <select
              value={year}
              onChange={(e) => setYear(Number(e.target.value))}
              className="w-full bg-zinc-900 border border-white/10 rounded px-3 py-2 text-sm text-white"
            >
              {YEARS.map((y) => (
                <option key={y} value={y}>{y}</option>
              ))}
            </select>
          </div>

          <div className="flex items-end">
            <button
              onClick={handleSearch}
              disabled={loading || !village}
              className="w-full bg-[#00ff88] text-black px-4 py-2 text-sm font-semibold rounded hover:bg-[#00cc6a] disabled:opacity-50"
            >
              {loading ? "Searching..." : "Search"}
            </button>
          </div>
        </div>

        {error && (
          <div className="mt-3 text-[#ff6b35] text-sm">{error}</div>
        )}
      </div>

      {/* Results */}
      {results && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">
              {results.village} ({results.year})
            </h2>
            <span className="text-zinc-500 text-sm">
              {results.total} registrations found
            </span>
          </div>

          {results.note && (
            <div className="text-xs text-zinc-500 bg-white/5 rounded p-2">
              {results.note}
            </div>
          )}

          {results.results.length === 0 ? (
            <div className="text-center py-12 text-zinc-500">
              <p>No registrations found for this property number.</p>
              <p className="text-xs mt-1">Try a different property number or year.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr>
                    <th className="text-left px-2.5 py-2 border-b border-white/10 text-[11px] text-zinc-500 uppercase">Index No</th>
                    <th className="text-left px-2.5 py-2 border-b border-white/10 text-[11px] text-zinc-500 uppercase">Document Type</th>
                    <th className="text-left px-2.5 py-2 border-b border-white/10 text-[11px] text-zinc-500 uppercase">Reg Date</th>
                    <th className="text-left px-2.5 py-2 border-b border-white/10 text-[11px] text-zinc-500 uppercase">Property Description</th>
                    <th className="text-right px-2.5 py-2 border-b border-white/10 text-[11px] text-zinc-500 uppercase">Amount</th>
                    <th className="text-right px-2.5 py-2 border-b border-white/10 text-[11px] text-zinc-500 uppercase">Stamp Duty</th>
                    <th className="text-left px-2.5 py-2 border-b border-white/10 text-[11px] text-zinc-500 uppercase">SRO</th>
                  </tr>
                </thead>
                <tbody>
                  {results.results.map((r: any, i: number) => (
                    <tr key={i} className="hover:bg-zinc-900">
                      <td className="px-2.5 py-2 border-b border-white/10 font-mono text-xs text-zinc-500">
                        {r.index_no}
                      </td>
                      <td className="px-2.5 py-2 border-b border-white/10">
                        <span className="text-xs px-1.5 py-0.5 rounded bg-[rgba(255,255,255,0.06)]">
                          {r.document_type || "—"}
                        </span>
                      </td>
                      <td className="px-2.5 py-2 border-b border-white/10 text-xs">
                        {r.registration_date || "—"}
                      </td>
                      <td className="px-2.5 py-2 border-b border-white/10 text-xs max-w-[300px] truncate">
                        {r.property_description || "—"}
                      </td>
                      <td className="px-2.5 py-2 border-b border-white/10 text-right font-mono text-xs">
                        {formatAmount(r.consideration_amount)}
                      </td>
                      <td className="px-2.5 py-2 border-b border-white/10 text-right font-mono text-xs">
                        {formatAmount(r.stamp_duty_paid)}
                      </td>
                      <td className="px-2.5 py-2 border-b border-white/10 text-xs">
                        {r.sro || "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Info */}
      <div className="bg-[#0a0f14] border border-white/10 rounded-lg p-4 text-sm text-zinc-500">
        <h3 className="font-semibold text-white mb-2">About IGR Search</h3>
        <ul className="space-y-1 list-disc list-inside">
          <li>Data sourced from IGR Maharashtra eSearch portal</li>
          <li>Requires exact CTS/Survey/Milkat/Gat/Plot number</li>
          <li>Building name search is NOT supported by IGR</li>
          <li>Mumbai data available from 1985, other districts from 2002</li>
          <li>For building-level enrichment, use the Building Enrichment pipeline instead</li>
        </ul>
      </div>
    </div>
  );
}

function formatAmount(amount: string): string {
  if (!amount || amount === "0") return "—";
  const num = parseFloat(amount.replace(/,/g, ""));
  if (isNaN(num)) return amount;
  if (num >= 10000000) return `₹${(num / 10000000).toFixed(2)} Cr`;
  if (num >= 100000) return `₹${(num / 100000).toFixed(2)} L`;
  return `₹${num.toLocaleString("en-IN")}`;
}
