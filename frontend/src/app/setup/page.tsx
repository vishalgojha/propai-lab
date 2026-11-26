"use client";

export const dynamic = "force-dynamic";

import SetupGuide from "@/components/SetupGuide";

export default function SetupPage() {
  return (
    <main className="mx-auto w-full max-w-3xl px-4 pb-16 pt-10">
      <SetupGuide variant="page" />
      <p className="mt-6 text-center text-xs leading-5 text-zinc-500">
        Your workspace stays private. Group listings reach other brokers only through a separate sharing
        confirmation, and every assistant connection needs your approval.
      </p>
    </main>
  );
}
