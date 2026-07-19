import SiteHeader from "@/components/SiteHeader";
import SiteFooter from "@/components/SiteFooter";

export default function Loading() {
  return (
    <div className="min-h-screen bg-black text-white">
      <SiteHeader />
      <main className="max-w-[1600px] mx-auto px-4 sm:px-8 xl:px-12 py-10 lg:py-14">
        <header className="max-w-5xl space-y-4">
          <div className="h-5 w-40 rounded-full skeleton" />
          <div className="h-10 w-3/4 rounded skeleton" />
          <div className="h-5 w-2/3 rounded skeleton" />
          <div className="h-12 w-full max-w-2xl rounded-2xl skeleton" />
        </header>

        <section className="mt-10">
          <div className="mb-6 flex flex-wrap gap-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="h-8 w-32 rounded-full skeleton" />
            ))}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5 lg:gap-7">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-56 rounded-2xl border border-white/10 bg-zinc-950/80 skeleton" />
            ))}
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
