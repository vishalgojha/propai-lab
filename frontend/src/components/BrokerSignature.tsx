"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowRight, PlugZap, Sparkles } from "lucide-react";

const messageLines = [
  "Connect Claude to PropAI",
  "https://mcp.propai.live/mcp",
  "OAuth approval required",
  "Private workspace only",
];

const fields = [
  ["Access", "Authorized"],
  ["Scope", "Your workspace"],
  ["Tools", "Search · Match"],
  ["Control", "You approve"],
];

export default function BrokerSignature() {
  const ref = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        setActive(true);
        observer.disconnect();
      }
    }, { threshold: 0.35 });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={ref} className={`broker-signature ${active ? "is-active" : ""}`}>
      <div className="broker-message-panel">
        <div className="broker-panel-meta"><span><PlugZap className="h-3.5 w-3.5" /> PropAI MCP connection</span><span>private · tenant-scoped</span></div>
        <div className="broker-message-bubble">
          {messageLines.map((line, index) => <p key={line} className="broker-message-line" style={{ transitionDelay: `${index * 180}ms` }}>{line}</p>)}
        </div>
      </div>
      <div className="broker-transform-label"><ArrowDown className="h-4 w-4" /> Claude connected to your workspace <ArrowRight className="h-4 w-4" /></div>
      <div className="broker-structured-card">
        <div className="broker-card-heading"><span><Sparkles className="h-4 w-4" /> Claude + PropAI</span><span className="broker-card-status">CONNECTED</span></div>
        <h3>Ask your private market</h3>
        <div className="broker-field-grid">
          {fields.map(([label, value], index) => <div key={label} className="broker-field" style={{ transitionDelay: `${900 + index * 140}ms` }}><span>{label}</span><b>{value}</b></div>)}
        </div>
        <div className="broker-source-note">Source context stays attached. Nothing sends without approval.</div>
      </div>
    </div>
  );
}
