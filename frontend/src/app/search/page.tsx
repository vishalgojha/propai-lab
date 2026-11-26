import Link from "next/link";

export const dynamic = "force-dynamic";

export default function SearchPage() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center px-6">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold tracking-tight text-text-primary">Search runs through your assistant</h1>
        <p className="mt-3 text-sm leading-6 text-text-secondary">
          PropAI&apos;s built-in search page has been retired with the built-in assistant. Search your workspace through
          Instinct or any MCP assistant. It covers your connected WhatsApp groups and listings other brokers have
          explicitly shared to the broker pool.
        </p>
        <p className="mt-3 text-sm leading-6 text-text-secondary">
          Looking for public listings without a login? Visit{" "}
          <a href="https://www.propai.live/search" className="font-medium text-text-primary underline underline-offset-2">
            www.propai.live/search
          </a>
          .
        </p>
        <Link
          href="/workspace/instinct"
          className="mt-6 inline-block rounded-lg border border-border px-4 py-2 text-sm font-semibold text-text-primary hover:bg-surface-hover"
        >
          Connect your assistant
        </Link>
      </div>
    </div>
  );
}
