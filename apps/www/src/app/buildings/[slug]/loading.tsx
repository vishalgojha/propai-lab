import Link from "next/link";
import SiteHeader from "@/components/SiteHeader";
import SiteFooter from "@/components/SiteFooter";

export default function Loading() {
  return (
    <div className="min-h-screen bg-black text-white">
      <SiteHeader />
      <main className="max-w-[1600px] mx-auto px-4 lg:px-6 py-10 lg:py-14">
        <div className="mb-8 h-4 w-32 rounded skeleton" />
        <header className="mb-10 space-y-4">
          <div className="h-9 w-1/2 rounded skeleton" />
          <div className="h-5 w-1/3 rounded skeleton" />
        </header>

        <h2 className="mb-6 h-6 w-40 rounded skeleton" />
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-4 lg:gap-6">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="h-52 rounded-2xl border border-white/10 bg-zinc-950/80 skeleton" />
          ))}
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
