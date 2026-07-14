"use client";

export const dynamic = "force-dynamic";

import { useEffect, useState } from "react";
import {
  MessageSquare,
  FileText,
  Building2,
  Users,
  Database,
  Brain,
  Clock,
  Wifi,
} from "lucide-react";
import * as api from "@/lib/api";

function StatCard({
  icon: Icon,
  label,
  value,
  sub,
  color,
}: {
  icon: any;
  label: string;
  value: string | number;
  sub?: string;
  color: string;
}) {
  return (
    <div className="rounded-2xl border border-white/10 bg-zinc-900/50 p-5">
      <div className="flex items-center gap-3 mb-3">
        <div
          className={`w-8 h-8 rounded-lg flex items-center justify-center ${color}`}
        >
          <Icon className="w-4 h-4" strokeWidth={1.5} />
        </div>
        <span className="text-[11px] font-medium text-zinc-500 uppercase tracking-wider">
          {label}
        </span>
      </div>
      <div className="text-2xl font-bold text-white tracking-tight">
        {value}
      </div>
      {sub && <div className="text-[11px] text-zinc-500 mt-1">{sub}</div>}
    </div>
  );
}

function fmt(n: number) {
  return n.toLocaleString();
}

function timeAgo(ts: string | null) {
  if (!ts) return "never";
  const diff = Date.now() - new Date(ts).getTime();
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

export default function UsagePage() {
  const [stats, setStats] = useState<api.UsageStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    api
      .getUsageStats()
      .then((data) => {
        if (active) setStats(data);
      })
      .catch(() => {})
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-zinc-500 text-sm">
        Loading...
      </div>
    );
  }

  if (!stats) {
    return (
      <div className="flex items-center justify-center h-64 text-zinc-500 text-sm">
        Failed to load usage data
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto px-4 lg:px-6 pt-10 pb-16">
      <div className="mb-8">
        <h2 className="text-lg font-bold text-white">System Usage</h2>
        <p className="mt-1 text-sm text-zinc-500">
          Data pipeline, AI, and chat activity
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <StatCard
          icon={MessageSquare}
          label="Messages"
          value={fmt(stats.total_messages)}
          sub={`${fmt(stats.messages_today)} today`}
          color="bg-blue-500/10 text-blue-400"
        />
        <StatCard
          icon={FileText}
          label="Parsed"
          value={fmt(stats.total_parsed)}
          sub={`${fmt(stats.total_listings)} listings`}
          color="bg-emerald-500/10 text-emerald-400"
        />
        <StatCard
          icon={Building2}
          label="Buildings"
          value={fmt(stats.total_buildings)}
          color="bg-amber-500/10 text-amber-400"
        />
        <StatCard
          icon={Users}
          label="Brokers"
          value={fmt(stats.total_brokers)}
          color="bg-purple-500/10 text-purple-400"
        />
        <StatCard
          icon={Database}
          label="Groups"
          value={fmt(stats.total_groups)}
          sub={`${fmt(stats.total_requirements)} requirements`}
          color="bg-cyan-500/10 text-cyan-400"
        />
        <StatCard
          icon={Brain}
          label="AI Requests"
          value={fmt(stats.ai_requests_today)}
          sub="today"
          color="bg-pink-500/10 text-pink-400"
        />
        <StatCard
          icon={MessageSquare}
          label="Chat Sessions"
          value={fmt(stats.total_chat_sessions)}
          sub={`${fmt(stats.total_chat_messages)} messages`}
          color="bg-indigo-500/10 text-indigo-400"
        />
        <StatCard
          icon={Clock}
          label="Last Sync"
          value={timeAgo(stats.last_sync)}
          sub={stats.broker_phone || undefined}
          color="bg-zinc-500/10 text-zinc-400"
        />
      </div>
    </div>
  );
}
