import { Users } from "lucide-react";
import { brokerGroupInviteUrl } from "@/lib/brokerGroupInvite";

export default function BrokerGroupInviteCard({ className = "" }: { className?: string }) {
  const url = brokerGroupInviteUrl();
  if (!url) return null;
  return (
    <section className={`rounded-2xl border border-white/10 p-6 ${className}`} data-testid="broker-group-invite">
      <h2 className="mb-2 flex items-center gap-2 text-sm font-bold text-white">
        <Users className="h-4 w-4 text-emerald-400" />
        PropAI brokers WhatsApp group
      </h2>
      <p className="mb-4 text-sm leading-6 text-zinc-400">
        Join the WhatsApp group for PropAI brokers. Joining is optional.
      </p>
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex min-h-11 items-center justify-center rounded-lg border border-emerald-400/40 px-4 py-2.5 text-sm font-bold text-emerald-200 transition-colors hover:bg-emerald-400/10"
      >
        Join the group on WhatsApp
      </a>
    </section>
  );
}
