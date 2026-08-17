"use client";

import { useSearchParams } from "next/navigation";
import { GroupedTabs } from "@/components/GroupedTabs";
import { ConnectionCenterPage } from "../connections/page";
import { WabaPage } from "../waba/page";

const tabs = [
  { id: "numbers", label: "My Numbers" },
  { id: "groups", label: "Groups" },
  { id: "business-api", label: "Business API" },
];

export default function WhatsAppPage() {
  const params = useSearchParams();
  const active = tabs.some((tab) => tab.id === params.get("tab")) ? params.get("tab")! : "numbers";
  return <main className={`propai-whatsapp-page mx-auto w-full px-4 pb-12 pt-8 lg:px-7 ${active === "groups" ? "max-w-none" : "max-w-7xl"}`}><h1 className="mb-1 text-2xl font-semibold text-white">WhatsApp</h1><p className="mb-6 text-sm text-zinc-500">Connect numbers, choose groups, and manage your business messaging.</p><GroupedTabs tabs={tabs} active={active} />{active === "business-api" ? <WabaPage /> : <ConnectionCenterPage view={active === "groups" ? "groups" : "numbers"} />}</main>;
}
