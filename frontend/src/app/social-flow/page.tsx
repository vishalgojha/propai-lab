"use client";

import { useEffect, useState } from "react";
import { ExternalLink, Megaphone } from "lucide-react";
import { getAccessToken } from "@/lib/auth";

export default function SocialFlowPage() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    getAccessToken().then((token) => {
      if (token) window.localStorage.setItem("propai_social_flow_token", token);
      setReady(true);
    });
  }, []);

  return (
    <div className="flex min-h-[calc(100dvh-44px)] flex-col">
      <div className="flex shrink-0 items-center justify-between border-b border-white/10 px-4 py-3 sm:px-6">
        <div className="flex items-center gap-2">
          <Megaphone className="h-4 w-4 text-accent" />
          <div><p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-accent">Growth</p><h1 className="text-lg font-semibold text-white">Agentic Realtor Ads Studio</h1></div>
        </div>
        <a href="/api/social-flow/studio/index.html" target="_blank" rel="noreferrer" className="flex items-center gap-2 rounded-lg border border-white/10 px-3 py-2 text-xs text-zinc-300 hover:text-white"><ExternalLink className="h-3.5 w-3.5" /> Open full Studio</a>
      </div>
      <div className="min-h-0 flex-1 bg-black">
        {ready ? <iframe title="Social Flow Agentic Studio" src="/api/social-flow/studio/index.html" className="h-[calc(100dvh-104px)] min-h-[720px] w-full border-0" /> : <div className="flex h-full items-center justify-center text-sm text-zinc-500">Opening Agentic Studio…</div>}
      </div>
    </div>
  );
}
