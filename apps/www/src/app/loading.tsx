import SiteHeader from "@/components/SiteHeader";

// Keep navigations visually stable while the server reads live inventory.
// The page itself has a bounded data timeout and will render an honest state
// instead of leaving this screen up indefinitely.
export default function Loading() {
  return (
    <div className="www-shell min-h-screen text-white">
      <SiteHeader />
      <main className="www-page-main www-content-page">
        <section className="mx-auto max-w-5xl space-y-8 text-center">
          <div className="mx-auto h-12 w-3/4 rounded skeleton" />
          <div className="mx-auto h-6 w-2/3 rounded skeleton" />
          <div className="mx-auto h-44 max-w-5xl rounded-3xl skeleton" />
        </section>
      </main>
    </div>
  );
}
