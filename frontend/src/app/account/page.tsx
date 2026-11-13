"use client";

import { useSearchParams } from "next/navigation";
import { GroupedTabs } from "@/components/GroupedTabs";
import { ProfilePage } from "../profile/page";
import { MembersPage } from "../profile/team/page";
import { BillingPage } from "../profile/billing/page";
import LLMProvidersPage from "../workspace/llm-providers/page";
import McpWorkspacePage from "../workspace/mcp/page";

const tabs = [{ id: "profile", label: "Profile" }, { id: "team", label: "Team" }, { id: "billing", label: "Billing" }, { id: "ai-providers", label: "AI Providers" }, { id: "mcp", label: "Integrations" }];

export default function AccountPage() {
  const params = useSearchParams();
  const requestedTab = params.get("tab");
  const active = requestedTab === "google-drive" || requestedTab === "instinct"
    ? "mcp"
    : tabs.some((tab) => tab.id === requestedTab)
      ? requestedTab!
      : "profile";
  return <main><div className="mx-auto max-w-4xl px-4 pt-8 lg:px-6"><h1 className="mb-1 text-2xl font-semibold text-white">Account</h1><p className="mb-6 text-sm text-zinc-500">Your profile, team, plan, workspace AI settings, and integrations.</p><GroupedTabs tabs={tabs} active={active} /></div>{active === "team" ? <MembersPage /> : active === "billing" ? <BillingPage /> : active === "ai-providers" ? <LLMProvidersPage /> : active === "mcp" ? <McpWorkspacePage /> : <ProfilePage />}</main>;
}
