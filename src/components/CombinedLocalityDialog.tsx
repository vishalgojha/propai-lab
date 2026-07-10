"use client";

import { useEffect, useState } from "react";

interface LocalityOption {
  name: string;
  count?: number;
}

interface CombinedLocalityDialogProps {
  isOpen: boolean;
  onClose: () => void;
  surfaceText: string;
  onSave: (expandsTo: string[]) => void;
}

export function CombinedLocalityDialog({
  isOpen,
  onClose,
  surfaceText,
  onSave,
}: CombinedLocalityDialogProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedLocalities, setSelectedLocalities] = useState<Set<string>>(new Set());
  const [localities, setLocalities] = useState<LocalityOption[]>([]);
  const [loading, setLoading] = useState(true);

  // Load known localities from the backend
  useEffect(() => {
    if (!isOpen) return;
    
    const loadLocalities = async () => {
      try {
        // Try to get localities from the API
        const res = await fetch("/api/trainer/localities");
        if (res.ok) {
          const data = await res.json();
          setLocalities(data.localities || []);
        } else {
          // Fallback to common Mumbai localities
          setLocalities(getDefaultLocalities());
        }
      } catch {
        setLocalities(getDefaultLocalities());
      } finally {
        setLoading(false);
      }
    };
    
    loadLocalities();
  }, [isOpen]);

  const filteredLocalities = localities
    .filter((loc) =>
      loc.name.toLowerCase().includes(searchQuery.toLowerCase())
    )
    .sort((a, b) => (b.count || 0) - (a.count || 0));

  const toggleLocality = (name: string) => {
    const newSelected = new Set(selectedLocalities);
    if (newSelected.has(name)) {
      newSelected.delete(name);
    } else {
      newSelected.add(name);
    }
    setSelectedLocalities(newSelected);
  };

  const handleSave = () => {
    if (selectedLocalities.size === 0) {
      alert("Please select at least one locality");
      return;
    }
    onSave(Array.from(selectedLocalities));
    onClose();
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-zinc-900 border border-white/10 rounded-xl w-full max-w-md max-h-[80vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-white/10">
          <div>
            <h3 className="text-lg font-semibold text-white">Combined Localities</h3>
            <p className="text-sm text-zinc-500">Observed: <span className="text-white font-mono">"{surfaceText}"</span></p>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-[rgba(255,255,255,0.06)] text-zinc-500 hover:text-white transition-colors"
            aria-label="Close"
          >
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M15 5L5 15M5 5L15 15" />
            </svg>
          </button>
        </div>

        {/* Search */}
        <div className="p-4 border-b border-white/10">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search localities..."
            className="w-full bg-black border border-white/10 rounded-lg px-3 py-2 text-white placeholder-[#4a5568] outline-none focus:border-emerald-500/40 transition-colors"
            autoFocus
          />
        </div>

        {/* Locality List */}
        <div className="flex-1 overflow-y-auto p-4 space-y-2">
          {loading ? (
            <div className="flex items-center justify-center h-32 text-zinc-500">
              Loading localities...
            </div>
          ) : filteredLocalities.length === 0 ? (
            <div className="flex items-center justify-center h-32 text-zinc-500">
              No localities found
            </div>
          ) : (
            filteredLocalities.map((loc) => (
              <label
                key={loc.name}
                className={`flex items-center gap-3 p-3 rounded-lg cursor-pointer transition-colors ${
                  selectedLocalities.has(loc.name)
                    ? "bg-emerald-500/10 border border-emerald-500/30"
                    : "bg-black border border-white/5 hover:border-white/10"
                }`}
              >
                <input
                  type="checkbox"
                  checked={selectedLocalities.has(loc.name)}
                  onChange={() => toggleLocality(loc.name)}
                  className="w-4 h-4 accent-emerald-500 cursor-pointer"
                />
                <span className="font-medium text-white flex-1 text-left">{loc.name}</span>
                {loc.count && (
                  <span className="text-xs text-zinc-500 bg-white/5 px-2 py-0.5 rounded">
                    {loc.count} occurrences
                  </span>
                )}
              </label>
            ))
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 p-4 border-t border-white/10">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-white/5 text-zinc-400 hover:bg-[rgba(255,255,255,0.08)] hover:text-white transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-emerald-500 text-white hover:bg-emerald-600 transition-colors"
            disabled={selectedLocalities.size === 0}
          >
            Save ({selectedLocalities.size})
          </button>
        </div>
      </div>
    </div>
  );
}

function getDefaultLocalities(): LocalityOption[] {
  return [
    { name: "Santacruz East", count: 150 },
    { name: "Santacruz West", count: 180 },
    { name: "Bandra West", count: 220 },
    { name: "Bandra East", count: 90 },
    { name: "Khar West", count: 120 },
    { name: "Khar East", count: 45 },
    { name: "Juhu", count: 200 },
    { name: "Andheri West", count: 300 },
    { name: "Andheri East", count: 280 },
    { name: "Versova", count: 140 },
    { name: "Lokhandwala", count: 160 },
    { name: "BKC", count: 110 },
    { name: "Powai", count: 190 },
    { name: "Goregaon West", count: 170 },
    { name: "Goregaon East", count: 130 },
    { name: "Malad West", count: 180 },
    { name: "Malad East", count: 95 },
    { name: "Kandivali West", count: 160 },
    { name: "Kandivali East", count: 100 },
    { name: "Borivali West", count: 150 },
    { name: "Borivali East", count: 85 },
    { name: "Dahisar", count: 70 },
    { name: "Mira Road", count: 90 },
    { name: "Bhayandar", count: 60 },
    { name: "Vasai", count: 55 },
    { name: "Virar", count: 50 },
    { name: "Thane West", count: 180 },
    { name: "Thane East", count: 95 },
    { name: "Vashi", count: 140 },
    { name: "Nerul", count: 110 },
    { name: "Belapur", count: 80 },
    { name: "Kharghar", count: 100 },
    { name: "Panvel", count: 90 },
    { name: "Wadala", count: 85 },
    { name: "Prabhadevi", count: 75 },
    { name: "Lower Parel", count: 120 },
    { name: "Dadar West", count: 160 },
    { name: "Dadar East", count: 110 },
    { name: "Mahim", count: 95 },
    { name: "Matunga", count: 85 },
    { name: "Sion", count: 90 },
    { name: "Kurla West", count: 130 },
    { name: "Kurla East", count: 80 },
    { name: "Ghatkopar West", count: 140 },
    { name: "Ghatkopar East", count: 95 },
    { name: "Mulund West", count: 110 },
    { name: "Mulund East", count: 75 },
    { name: "Vile Parle West", count: 120 },
    { name: "Vile Parle East", count: 70 },
    { name: "Jogeshwari West", count: 85 },
    { name: "Jogeshwari East", count: 60 },
    { name: "Oshiwara", count: 75 },
    { name: "Goregaon", count: 150 },
    { name: "Marol", count: 65 },
    { name: "Sakivihar", count: 45 },
    { name: "Kalina", count: 70 },
    { name: "Vidyavihar", count: 55 },
    { name: "Chembur West", count: 100 },
    { name: "Chembur East", count: 65 },
    { name: "Deonar", count: 50 },
    { name: "Trombay", count: 45 },
    { name: "Worli", count: 140 },
    { name: "Prabhadevi", count: 75 },
    { name: "Dadar", count: 130 },
    { name: "Matunga", count: 85 },
    { name: "Sion", count: 90 },
    { name: "Kings Circle", count: 60 },
    { name: "Byculla", count: 55 },
    { name: "Marine Lines", count: 45 },
    { name: "Churchgate", count: 80 },
    { name: "Colaba", count: 100 },
    { name: "Cuffe Parade", count: 65 },
    { name: "Walkeshwar", count: 70 },
    { name: "Malabar Hill", count: 90 },
    { name: "Peddar Road", count: 50 },
    { name: "Altamount Road", count: 45 },
    { name: "Nepean Sea Road", count: 60 },
    { name: "Breach Candy", count: 55 },
    { name: "Tardeo", count: 60 },
    { name: "Grant Road", count: 50 },
    { name: "Mumbai Central", count: 70 },
  ];
}