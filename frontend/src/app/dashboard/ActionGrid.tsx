"use client";

import { useRouter } from "next/navigation";
import { ArrowRight, ListChecks, MessageCircle, Radio, Search } from "lucide-react";

export default function ActionGrid({ suggestionPending }: { suggestionPending: number }) {
  const router = useRouter();
  return (
    <section aria-labelledby="actions-heading">
      <div className="dashboard-section-heading"><div><h2 id="actions-heading">Move the work forward</h2><p>Jump straight into the parts of your workspace that need attention.</p></div></div>
      <div className="dashboard-action-grid">
        {[
          { label: "Connect your assistant", count: "→", icon: Search, href: "/workspace/instinct", detail: "Use Instinct, Claude, or Gemini with your PropAI data" },
          { label: "Review Items", count: suggestionPending || "→", icon: ListChecks, href: "/inbox", detail: "Records needing confirmation" },
          { label: "Review market data", count: "→", icon: MessageCircle, href: "/inbox", detail: "Triage and correct captured market posts" },
          { label: "Connect groups", count: "→", icon: Radio, href: "/whatsapp?tab=groups", detail: "Choose groups to connect for parsing" },
        ].map(card => (
          <button
            key={card.label}
            onClick={() => router.push(card.href)}
            className="dashboard-action-card"
          >
            <div className="flex items-center justify-between mb-1">
              <span className="dashboard-action-icon"><card.icon strokeWidth={1.7} /></span>
              {typeof card.count === "number" && card.count > 0 ? (
                  <span className="dashboard-action-count">{card.count}</span>
              ) : (
                  <ArrowRight className="w-5 h-5" strokeWidth={1.5} />
              )}
            </div>
            <div className="dashboard-action-label">{card.label}</div>
            <div className="dashboard-action-detail">{card.detail}</div>
          </button>
        ))}
      </div>
    </section>
  );
}
