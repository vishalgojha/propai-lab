export default function PromotionsPage() {
  return (
    <div className="max-w-3xl">
      <h2 className="text-lg font-bold text-[#e2e8f0]">Promotions</h2>
      <div className="mt-4 rounded-2xl border border-[rgba(255,255,255,0.06)] bg-[#0d1117] p-8 text-center">
        <div className="text-sm font-semibold text-[#e2e8f0]">No promotions yet.</div>
        <div className="mt-2 text-sm text-[#64748b]">
          Promote a verified listing from My Inventory.
        </div>
        <div className="mt-5 flex justify-center gap-2">
          <a href="/my/inventory" className="rounded-lg bg-[#3EE88A] px-4 py-2 text-sm font-bold text-[#04100a] no-underline">
            My Inventory
          </a>
          <a href="/knowledge" className="rounded-lg border border-[rgba(255,255,255,0.1)] px-4 py-2 text-sm text-[#e2e8f0] no-underline hover:bg-[#111820]">
            Knowledge Base
          </a>
        </div>
      </div>
    </div>
  );
}
