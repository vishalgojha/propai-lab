"use client";

import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import SiteHeader from "@/components/SiteHeader";
import SiteFooter from "@/components/SiteFooter";

export default function SearchError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="min-h-screen bg-black text-white">
      <SiteHeader />
      <main className="mx-auto max-w-3xl px-4 py-20 text-center">
        <AlertTriangle className="mx-auto h-12 w-12 text-amber-400 mb-4" />
        <h1 className="text-2xl font-bold text-white mb-2">
          Something went wrong
        </h1>
        <p className="text-zinc-400 mb-6">
          Search hit an unexpected error. You can try again or head back to the
          homepage.
        </p>
        <div className="flex items-center justify-center gap-3">
          <button
            onClick={reset}
            className="rounded-lg bg-green-400 px-5 py-2.5 text-sm font-semibold text-black hover:bg-green-300 transition-colors"
          >
            Try again
          </button>
          <Link
            href="/"
            className="rounded-lg border border-white/10 px-5 py-2.5 text-sm text-zinc-300 hover:border-white/20 transition-colors"
          >
            Go home
          </Link>
        </div>
        {error.digest && (
          <p className="mt-6 text-xs text-zinc-600">Ref: {error.digest}</p>
        )}
      </main>
      <SiteFooter />
    </div>
  );
}
