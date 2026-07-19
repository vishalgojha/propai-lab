import SiteHeader from "@/components/SiteHeader";
import SiteFooter from "@/components/SiteFooter";

export default function Loading() {
  return (
    <div className="min-h-screen bg-black text-white">
      <SiteHeader />
      <main className="mx-auto max-w-5xl px-4 py-8 lg:px-6 lg:py-12">
        <div className="mb-5 h-4 w-36 rounded skeleton" />
        <div className="mb-6 flex flex-wrap items-center gap-1.5">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-3 w-16 rounded skeleton" />
          ))}
        </div>

        <div className="grid grid-cols-1 gap-7 lg:grid-cols-[1fr_300px]">
          <div>
            <div className="relative h-64 w-full rounded-2xl border border-white/10 bg-zinc-950/80 skeleton" />
            <div className="mt-6 space-y-4">
              <div className="h-5 w-1/3 rounded skeleton" />
              <div className="h-8 w-2/3 rounded skeleton" />
              <div className="h-9 w-40 rounded skeleton" />
            </div>
            <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="h-16 rounded-xl border border-white/10 bg-zinc-950/90 skeleton" />
              ))}
            </div>
          </div>
          <div className="hidden space-y-4 lg:block">
            <div className="h-64 rounded-2xl border border-white/10 bg-zinc-950/80 skeleton" />
            <div className="h-40 rounded-2xl border border-white/10 bg-zinc-950/80 skeleton" />
          </div>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
