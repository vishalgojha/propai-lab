"use client";

export const dynamic = "force-dynamic";

export default function GroupsPage() {
  return (
    <div className="mx-auto max-w-3xl py-16 text-center">
      <h1 className="text-xl font-semibold text-white">WhatsApp groups are paused</h1>
      <p className="mt-3 text-sm text-zinc-400">
        Group management will return when the active extraction pipeline is ready.
      </p>
      <a
        href="/connections"
        className="mt-6 inline-flex rounded-lg bg-[#3EE88A] px-4 py-2 text-sm font-semibold text-black hover:bg-[#74f0a5]"
      >
        Manage WhatsApp connections
      </a>
    </div>
  );
}
