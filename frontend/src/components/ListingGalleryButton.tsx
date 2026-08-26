export default function ListingGalleryButton({ listingId, count }: { listingId?: number; count?: number }) {
  if (!listingId || !count) return null;
  return <span className="inline-flex items-center gap-1 text-emerald-300">Has photos ({count})</span>;
}
