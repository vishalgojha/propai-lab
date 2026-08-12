"use client";

import { useSearchParams } from "next/navigation";
import { GroupedTabs } from "@/components/GroupedTabs";
import { ProfilePage } from "../profile/page";
import { MembersPage } from "../profile/team/page";
import { BillingPage } from "../profile/billing/page";

const tabs = [{ id: "profile", label: "Profile" }, { id: "team", label: "Team" }, { id: "billing", label: "Billing" }];

export default function AccountPage() {
  const params = useSearchParams();
  const active = tabs.some((tab) => tab.id === params.get("tab")) ? params.get("tab")! : "profile";
  return <main><div className="mx-auto max-w-4xl px-4 pt-8 lg:px-6"><h1 className="mb-1 text-2xl font-semibold text-white">Account</h1><p className="mb-6 text-sm text-zinc-500">Your profile, team, and plan.</p><GroupedTabs tabs={tabs} active={active} /></div>{active === "team" ? <MembersPage /> : active === "billing" ? <BillingPage /> : <ProfilePage />}</main>;
}
