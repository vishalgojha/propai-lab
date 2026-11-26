export const dynamic = "force-dynamic";

import Link from "next/link";

export default function ChatPage() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center px-6">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold tracking-tight text-text-primary">PropAI assistant retired</h1>
        <p className="mt-3 text-sm leading-6 text-text-secondary">
          The built-in PropAI assistant has been switched off. Use Instinct or MCP to work with your PropAI data instead. Your WhatsApp group capture keeps running.
        </p>
        <Link
          href="/dashboard"
          className="mt-6 inline-block rounded-lg border border-border px-4 py-2 text-sm font-semibold text-text-primary hover:bg-surface-hover"
        >
          Go to dashboard
        </Link>
      </div>
    </div>
  );
}
