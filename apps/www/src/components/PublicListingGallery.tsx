import type { PublicListingPhoto } from "@/lib/public-data";

export default function PublicListingGallery({ photos }: { photos: PublicListingPhoto[] }) {
  if (!photos.length) return null;
  return (
    <section className="mt-8" aria-labelledby="property-photos-heading">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 id="property-photos-heading" className="text-sm font-semibold uppercase tracking-[0.14em] text-[#a6c3b2]">Property photos</h2>
        <span className="rounded-full border border-[#4fb27d]/40 bg-[#214936] px-2.5 py-1 text-xs text-[#b0e6c6]">
          {photos.length} photo{photos.length === 1 ? "" : "s"}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {photos.map((photo) => (
          <figure key={photo.id} className="overflow-hidden rounded-xl border border-white/10 bg-[#173325]">
            <img src={photo.url} alt={photo.caption || "Property photo"} className="aspect-[4/3] w-full object-cover" loading="lazy" />
            {photo.caption && <figcaption className="truncate px-3 py-2 text-xs text-[#a6c3b2]">{photo.caption}</figcaption>}
          </figure>
        ))}
      </div>
    </section>
  );
}
