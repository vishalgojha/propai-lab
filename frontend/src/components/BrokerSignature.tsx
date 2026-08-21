"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowRight, MessageSquare, Sparkles } from "lucide-react";

const messageLines = [
  "*2 BHK AVAILABLE*",
  "Rent – ₹1.25L",
  "Bandra West · high floor",
  "Available immediately",
];

const fields = [
  ["Intent", "Rent"],
  ["Configuration", "2 BHK"],
  ["Locality", "Bandra West"],
  ["Freshness", "Last seen today"],
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
        <div className="broker-panel-meta"><span><MessageSquare className="h-3.5 w-3.5" /> Illustrative WhatsApp message</span><span>forwarded · 11:42 pm</span></div>
        <div className="broker-message-bubble">
          {messageLines.map((line, index) => <p key={line} className="broker-message-line" style={{ transitionDelay: `${index * 180}ms` }}>{line}</p>)}
        </div>
      </div>
      <div className="broker-transform-label"><ArrowDown className="h-4 w-4" /> structured in seconds <ArrowRight className="h-4 w-4" /></div>
      <div className="broker-structured-card">
        <div className="broker-card-heading"><span><Sparkles className="h-4 w-4" /> PropAI structured view</span><span className="broker-card-status">SEARCHABLE</span></div>
        <h3>2 BHK in Bandra West</h3>
        <div className="broker-field-grid">
          {fields.map(([label, value], index) => <div key={label} className="broker-field" style={{ transitionDelay: `${900 + index * 140}ms` }}><span>{label}</span><b>{value}</b></div>)}
        </div>
        <div className="broker-source-note">Source context stays attached for verification.</div>
      </div>
    </div>
  );
}
