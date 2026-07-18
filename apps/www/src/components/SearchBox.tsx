import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowRight, Search, MapPin } from "lucide-react";

type LocalitySuggestion = { locality: string; slug: string; listingCount: number };

export default function SearchBox({
  query,
  asset,
  localities,
}: {
  query: string;
  asset: string;
  localities: LocalitySuggestion[];
}) {
  const router = useRouter();
  const [value, setValue] = useState(query);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [justTyped, setJustTyped] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const suggestions = useMemo(() => {
    const q = value.trim().toLowerCase();
    if (!q) return [];
    return localities
      .filter((l) => l.locality.toLowerCase().includes(q))
      .sort((a, b) => b.listingCount - a.listingCount)
      .slice(0, 8);
  }, [value, localities]);

  // Keep the dropdown open while the user is actively typing a partial match,
  // but let an explicit submit close it.
  useEffect(() => {
    if (justTyped) {
      setOpen(suggestions.length > 0);
      setJustTyped(false);
    }
  }, [justTyped, suggestions.length]);

  // Close on outside click.
  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  function submitSearch(override?: string) {
    const q = (override ?? value).trim();
    setOpen(false);
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (asset) params.set("asset", asset);
    const qs = params.toString();
    router.push(qs ? `/search?${qs}` : "/search");
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!open && suggestions.length) {
        setOpen(true);
        setActive(0);
        return;
      }
      setActive((i) => Math.min(i + 1, suggestions.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      // Enter on a highlighted suggestion -> go to that locality page.
      if (open && active >= 0 && suggestions[active]) {
        e.preventDefault();
        router.push(`/localities/${suggestions[active].slug}`);
        setOpen(false);
      }
      // Otherwise let the form submit the natural-language search.
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  return (
    <div ref={containerRef} className="relative">
      <div className="relative rounded-[28px] border border-white/10 bg-zinc-950/90 p-4 lg:p-5 shadow-[0_25px_80px_rgba(0,0,0,0.45)]">
        <div className="absolute inset-0 rounded-[28px] bg-gradient-to-br from-green-400/10 via-transparent to-transparent pointer-events-none" />
        <div className="flex items-center justify-between mb-3">
          <label htmlFor="natural-search" className="block text-sm font-medium text-zinc-400">
            Search in plain English
          </label>
          <div className="flex items-center gap-1 rounded-full border border-white/10 bg-black/60 p-1">
            {[
              { value: "", label: "All" },
              { value: "residential", label: "Residential" },
              { value: "commercial", label: "Commercial" },
            ].map((opt) => {
              const activeOpt = asset === opt.value;
              return (
                <label
                  key={opt.value}
                  className={`cursor-pointer select-none rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                    activeOpt ? "bg-green-400 text-black" : "text-zinc-400 hover:text-white"
                  }`}
                >
                  <input
                    type="radio"
                    name="asset"
                    value={opt.value}
                    defaultChecked={activeOpt}
                    className="sr-only"
                    onChange={() => {
                      const params = new URLSearchParams();
                      if (value.trim()) params.set("q", value.trim());
                      if (opt.value) params.set("asset", opt.value);
                      const qs = params.toString();
                      router.push(qs ? `/search?${qs}` : "/search");
                    }}
                  />
                  {opt.label}
                </label>
              );
            })}
          </div>
        </div>
        <div className="relative">
          <Search className="absolute left-5 top-1/2 -translate-y-1/2 h-5 w-5 text-zinc-500" aria-hidden="true" />
          <form
            onSubmit={(e) => {
              e.preventDefault();
              submitSearch();
            }}
          >
            <input
              id="natural-search"
              name="q"
              ref={inputRef}
              type="search"
              value={value}
              autoComplete="off"
              placeholder="e.g. 3 BHK in Bandra West budget 2 to 3 lakh"
              className="w-full rounded-2xl border border-white/10 bg-black/80 py-5 pl-14 pr-28 text-[16px] lg:text-[18px] text-white placeholder:text-zinc-500 focus:border-green-400 focus:outline-none focus:ring-1 focus:ring-green-400"
              onChange={(e) => {
                setValue(e.target.value);
                setActive(-1);
                setJustTyped(true);
              }}
              onFocus={() => {
                if (suggestions.length) setOpen(true);
              }}
              onKeyDown={onKeyDown}
            />
            <button
              type="submit"
              className="absolute right-3 top-1/2 -translate-y-1/2 inline-flex items-center gap-2 rounded-xl bg-green-400 px-4 py-2.5 text-sm font-semibold text-black transition-colors hover:bg-green-300"
            >
              Search
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </button>
          </form>
        </div>
        <p className="mt-3 text-sm text-zinc-500">
          Try a locality, building, broker, BHK, or a full request like “3 BHK in Bandra West budget 2 to 3 lakh”.
        </p>
      </div>

      {open && suggestions.length > 0 && (
        <ul className="absolute z-20 mt-2 w-full overflow-hidden rounded-2xl border border-white/10 bg-zinc-950 shadow-[0_25px_80px_rgba(0,0,0,0.55)]">
          {suggestions.map((s, i) => (
            <li key={s.slug}>
              <Link
                href={`/localities/${s.slug}`}
                className={`flex items-center justify-between gap-3 px-4 py-3 text-sm transition-colors ${
                  i === active ? "bg-green-400/15 text-white" : "text-zinc-300 hover:bg-white/5"
                }`}
                onMouseEnter={() => setActive(i)}
                onClick={() => setOpen(false)}
              >
                <span className="flex items-center gap-2">
                  <MapPin className="h-4 w-4 text-green-400" aria-hidden="true" />
                  {s.locality}
                </span>
                <span className="text-xs text-zinc-500">
                  {s.listingCount.toLocaleString()} listings
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
