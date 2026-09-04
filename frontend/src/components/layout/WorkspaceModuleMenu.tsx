"use client";

import { useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { ChevronDown, LayoutGrid } from "lucide-react";

type ModuleItem = { href: string; label: string };
type ModuleSection = { title: string; items: ModuleItem[] };

const sections: ModuleSection[] = [
  { title: "Intelligence", items: [{ href: "/inbox", label: "Market Inbox" }, { href: "/chat", label: "Search & Chat" }, { href: "/auto-matched", label: "Auto Matched" }] },
  { title: "Workspace", items: [{ href: "/crm", label: "Private CRM" }, { href: "/deals", label: "My Deals" }, { href: "/clients", label: "My Clients" }] },
  { title: "Connections", items: [{ href: "/whatsapp?tab=numbers", label: "WhatsApp" }, { href: "/account?tab=google-drive", label: "Google Drive" }, { href: "/social-flow", label: "Realtor Ads Studio" }] },
  { title: "Operations", items: [{ href: "/admin/pipeline-health?tab=providers", label: "Pipeline Health" }, { href: "/brokers", label: "Broker Profiles" }, { href: "/admin", label: "Super Admin" }] },
];

export function WorkspaceModuleMenu() {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const router = useRouter();
  return (
    <div className="relative shrink-0">
      <button type="button" onClick={() => setOpen((value) => !value)} className="workspace-module-trigger" aria-expanded={open} aria-haspopup="menu">
        <LayoutGrid className="h-3.5 w-3.5" aria-hidden="true" /><span>Modules</span><ChevronDown className={`h-3 w-3 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden="true" />
      </button>
      {open && <div className="workspace-module-menu" role="menu" aria-label="PropAI modules">
        <div className="workspace-module-heading">Workspace modules</div>
        {sections.map((section) => <div key={section.title} className="workspace-module-section">
          <div className="workspace-module-section-title">{section.title}</div>
          {section.items.map((item) => { const itemPath = item.href.split("?")[0]; const active = pathname === itemPath || pathname.startsWith(`${itemPath}/`); return (
            <button key={item.href} type="button" role="menuitem" className={`workspace-module-item ${active ? "is-active" : ""}`} onClick={() => { setOpen(false); router.push(item.href); }}>
              <span className="workspace-module-dot" aria-hidden="true" /><span>{item.label}</span>{active && <span className="workspace-module-current">Current</span>}
            </button>
          ); })}
        </div>)}
      </div>}
    </div>
  );
}
