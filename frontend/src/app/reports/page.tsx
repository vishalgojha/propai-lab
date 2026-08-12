"use client";

import { useSearchParams } from "next/navigation";
import { GroupedTabs } from "@/components/GroupedTabs";
import { UsagePage } from "../usage/page";
import { AdminAnalyticsPage } from "../admin/analytics/page";

const tabs = [{ id: "usage", label: "Usage" }, { id: "activity", label: "Activity" }];

export default function ReportsPage() {
  const params = useSearchParams();
  const active = params.get("tab") === "activity" ? "activity" : "usage";
  return <main><div className="mx-auto max-w-5xl px-4 pt-8 lg:px-8"><h1 className="mb-1 text-2xl font-semibold text-white">Reports</h1><p className="mb-6 text-sm text-zinc-500">A clear view of your workspace usage and activity.</p><GroupedTabs tabs={tabs} active={active} /></div>{active === "activity" ? <AdminAnalyticsPage /> : <UsagePage />}</main>;
}
