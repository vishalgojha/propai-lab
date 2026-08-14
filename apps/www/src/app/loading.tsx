import SiteHeader from "@/components/SiteHeader";

// Transitional UI for the live homepage. The final page remains server-rendered
// with real data; this only appears while a navigation is waiting on Supabase.
export default function Loading() {
  return (
    <div className="min-h-screen bg-black text-white">
      <SiteHeader />
      <main className="mx-auto max-w-[1600px] px-4 py-16 lg:px-6 lg:py-24">
        <section className="mx-auto max-w-5xl space-y-8 text-center">
          <div className="mx-auto h-12 w-3/4 rounded skeleton" />
          <div className="mx-auto h-6 w-2/3 rounded skeleton" />
          <div className="mx-auto h-44 max-w-5xl rounded-3xl skeleton" />
        </section>
      </main>
    </div>
  );
}
