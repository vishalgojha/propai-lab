export default function PromotionsPage() {
  return (
    <div className="max-w-3xl">
      <h2 className="text-lg font-bold text-white">Promotions</h2>
      <div className="mt-4 rounded-2xl border border-white/10 bg-zinc-900 p-8 text-center">
        <div className="text-sm font-semibold text-white">No promotions yet.</div>
        <div className="mt-2 text-sm text-zinc-500">
          Promote a verified listing from My Inventory.
        </div>
        <div className="mt-5 flex justify-center gap-2">
          <a href="/my/inventory" className="rounded-lg bg-[#3EE88A] px-4 py-2 text-sm font-bold text-black no-underline">
            My Inventory
          </a>
          <a href="/knowledge" className="rounded-lg border border-white/10 px-4 py-2 text-sm text-white no-underline hover:bg-zinc-800">
            Knowledge Base
          </a>
        </div>
      </div>
    </div>
  );
}
