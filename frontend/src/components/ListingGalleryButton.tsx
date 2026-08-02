"use client";

import { useState } from "react";
import { Camera, X } from "lucide-react";
import { fetchJSON } from "@/lib/api";
import { getAccessToken } from "@/lib/auth";

type Photo = { id: number; url: string; caption?: string };

export default function ListingGalleryButton({ listingId, count }: { listingId?: number; count?: number }) {
  const [open, setOpen] = useState(false);
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function show() {
    if (!listingId) return;
    setOpen(true);
    if (photos.length || loading) return;
    setLoading(true);
    try {
      const metadata = await fetchJSON<Photo[]>(`/listings/${listingId}/photos`);
      const token = await getAccessToken();
      const resolved = await Promise.all(metadata.map(async (photo) => {
        const response = await fetch(photo.url, { headers: token ? { Authorization: `Bearer ${token}` } : {}, cache: "no-store" });
        if (!response.ok) throw new Error("photo request failed");
        return { ...photo, url: URL.createObjectURL(await response.blob()) };
      }));
      setPhotos(resolved);
    } catch {
      setError("Photos are temporarily unavailable.");
    } finally {
      setLoading(false);
    }
  }

  if (!listingId || !count) return null;
  return <>
    <button type="button" onClick={show} className="inline-flex items-center gap-1 text-emerald-300 hover:text-emerald-200">
      <Camera className="h-3 w-3" /> Images ({count})
    </button>
    {open && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" onClick={() => setOpen(false)}>
      <div className="relative max-h-[90vh] w-full max-w-4xl rounded-xl border border-white/10 bg-zinc-950 p-4" onClick={(event) => event.stopPropagation()}>
        <button type="button" onClick={() => setOpen(false)} className="absolute right-3 top-3 rounded-full bg-black/70 p-2" aria-label="Close gallery"><X className="h-4 w-4" /></button>
        <div className="mb-3 pr-10 text-sm font-semibold text-white">Property images</div>
        {loading && <div className="py-16 text-center text-sm text-zinc-400">Loading images…</div>}
        {error && <div className="py-16 text-center text-sm text-amber-300">{error}</div>}
        {!loading && !error && !photos.length && <div className="py-16 text-center text-sm text-zinc-400">No images are attached yet.</div>}
        <div className="grid max-h-[78vh] grid-cols-1 gap-3 overflow-auto sm:grid-cols-2">
          {photos.map((photo) => <figure key={photo.id} className="overflow-hidden rounded-lg border border-white/10 bg-black"><img src={photo.url} alt={photo.caption || "Property photo"} className="max-h-[60vh] w-full object-contain" />{photo.caption && <figcaption className="p-2 text-xs text-zinc-400">{photo.caption}</figcaption>}</figure>)}
        </div>
      </div>
    </div>}
  </>;
}
