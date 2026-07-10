"use client";

import { useMemo, useState, type ReactNode } from "react";
import type { ChatResponse, WorkspaceBlock, WorkspaceBlockAction } from "@/lib/api";

type Props = {
  response: ChatResponse;
  onPromptSelect?: (value: string) => void;
};

function chipClass(tone?: string) {
  if (tone === "good") return "bg-emerald-500/10 text-emerald-300 border-emerald-500/20";
  if (tone === "warn") return "bg-amber-500/10 text-amber-300 border-amber-500/20";
  if (tone === "bad") return "bg-rose-500/10 text-rose-300 border-rose-500/20";
  if (tone === "accent") return "bg-blue-500/10 text-blue-300 border-blue-500/20";
  return "bg-white/5 text-zinc-300 border-white/10";
}

function frame(children: ReactNode, className = "") {
  return <div className={`rounded-xl border border-white/10 p-4 ${className}`}>{children}</div>;
}

function toText(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function displayText(value: unknown): string {
  return toText(value)
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\*([^*\n]+)\*/g, "$1")
    .replace(/_([^_\n]+)_/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*]\s+/gm, "")
    .trim();
}

function sanitizeWorkspaceValue(value: unknown, key = ""): unknown {
  if (typeof value === "string") {
    if (["href", "url", "source", "source_name", "source_type", "origin", "origin_source", "dataset", "table"].includes(key)) {
      return value;
    }
    return displayText(value);
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeWorkspaceValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([entryKey, entryValue]) => [
        entryKey,
        sanitizeWorkspaceValue(entryValue, entryKey),
      ]),
    );
  }
  return value;
}

function sanitizeWorkspaceBlock(block: WorkspaceBlock): WorkspaceBlock {
  return sanitizeWorkspaceValue(block) as WorkspaceBlock;
}

function sourceToken(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function sourceLabel(value: string) {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (ch) => ch.toUpperCase())
    .trim();
}

function collectItemSources(item: any): string[] {
  const values = [
    item?.source,
    item?.source_name,
    item?.source_type,
    item?.origin,
    item?.origin_source,
    item?.dataset,
    item?.table,
    item?.channel,
    item?.group_source,
  ]
    .map((value) => toText(value))
    .filter(Boolean);
  return values.map(sourceToken);
}

function blockSources(block: WorkspaceBlock): string[] {
  const fromBlock = Array.isArray(block.sources) ? block.sources : [];
  const fromItems = [...(block.items || []), ...(block.rows || []), ...(block.cards || []), ...(block.events || [])]
    .flatMap((item: any) => collectItemSources(item));
  return [...new Set([...fromBlock, ...fromItems].map(sourceToken).filter(Boolean))];
}

function splitBullets(text: string): string[] {
  return text
    .split(/\n+/)
    .map((line) => line.trim())
    .map((line) => line.replace(/^[•\-–—\d. )]+/, "").trim())
    .filter(Boolean)
    .slice(0, 8);
}

function summarizeContent(content: string): { body?: string; bullets?: string[] } {
  const normalized = (content || "").trim();
  if (!normalized) return {};
  const lines = splitBullets(normalized);
  if (lines.length >= 2) {
    return {
      bullets: lines,
      body: lines.length < 3 ? normalized : undefined,
    };
  }
  const sentences = normalized
    .split(/(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (sentences.length >= 3) {
    return { bullets: sentences.slice(0, 6) };
  }
  return { body: normalized };
}

function blockMatchesSource(block: WorkspaceBlock, activeSource: string | null) {
  if (!activeSource) return true;
  if (["summary", "error_state", "empty_state", "loading", "export_panel", "suggested_questions"].includes(block.type)) {
    return true;
  }
  const sources = blockSources(block);
  if (sources.length === 0) return block.type === "summary";
  return sources.includes(sourceToken(activeSource));
}

function filterBySource(items: any[] = [], activeSource: string | null) {
  if (!activeSource) return items;
  const target = sourceToken(activeSource);
  return items.filter((item) => {
    const sources = collectItemSources(item);
    return sources.length === 0 ? true : sources.includes(target);
  });
}

function actionButton(action: WorkspaceBlockAction, onPromptSelect?: (value: string) => void) {
  const value = action.value || action.label;
  if (action.href) {
    return (
      <a
        key={`${action.label}-${action.href}`}
        href={action.href}
        className="text-[10px] px-2.5 py-1 rounded border border-white/10 text-zinc-400 hover:text-white hover:border-blue-500/30 transition-colors"
      >
        {action.label}
      </a>
    );
  }
  return (
    <button
      key={`${action.label}-${value}`}
      onClick={() => onPromptSelect?.(value)}
      className="text-[10px] px-2.5 py-1 rounded border border-white/10 text-zinc-400 hover:text-white hover:border-blue-500/30 transition-colors"
    >
      {action.label}
    </button>
  );
}

function SummaryBlock({ block, onPromptSelect }: { block: WorkspaceBlock; onPromptSelect?: (value: string) => void }) {
  const title = block.title && block.title.toLowerCase() === "answer" ? "Result" : block.title || "Result";
  const narrative = block.body || block.description || block.summary || "";
  const compact = block.bullets && block.bullets.length > 0 ? null : summarizeContent(narrative);
  return frame(
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-white">{title}</div>
          {block.subtitle && <div className="text-xs text-zinc-500 mt-1">{block.subtitle}</div>}
        </div>
        {block.note && <div className="text-[10px] text-zinc-500">{block.note}</div>}
      </div>
      {(block.body || block.description || block.summary) && (
        compact?.bullets && compact.bullets.length > 0 ? (
          <div className="grid gap-2 sm:grid-cols-2">
            {compact.bullets.map((bullet) => (
              <div key={bullet} className="rounded-lg border border-white/10 bg-[#0b1016] px-3 py-2 text-sm text-white">
                {bullet}
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-zinc-300 leading-6 whitespace-pre-wrap">{narrative}</p>
        )
      )}
      {Array.isArray(block.metrics) && block.metrics.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {block.metrics.map((metric) => (
            <span key={metric.label} className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[11px] ${chipClass(metric.tone)}`}>
              <span className="uppercase tracking-wider text-[9px] opacity-70">{metric.label}</span>
              <span className="font-medium">{metric.value}</span>
            </span>
          ))}
        </div>
      )}
      {Array.isArray(block.bullets) && block.bullets.length > 0 && (
        <div className="space-y-1 text-sm text-zinc-400">
          {block.bullets.map((bullet) => (
            <div key={bullet}>• {bullet}</div>
          ))}
        </div>
      )}
      {Array.isArray(block.actions) && block.actions.length > 0 && (
        <div className="flex flex-wrap gap-2">{block.actions.map((action) => actionButton(action, onPromptSelect))}</div>
      )}
    </div>,
  );
}

function CompactCard({
  title,
  subtitle,
  meta,
  body,
  actions,
  onPromptSelect,
}: {
  title: string;
  subtitle?: string;
  meta?: string[];
  body?: string;
  actions?: WorkspaceBlockAction[];
  onPromptSelect?: (value: string) => void;
}) {
  return (
    <div className="rounded-xl border border-white/10 bg-[#0b1016] p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-white truncate">{title || "—"}</div>
          {subtitle && <div className="text-[11px] text-zinc-500 mt-1">{subtitle}</div>}
        </div>
      </div>
      {meta && meta.length > 0 && <div className="mt-2 flex flex-wrap gap-2 text-[10px] text-zinc-400">{meta.map((item) => <span key={item} className="rounded-full border border-white/10 px-2 py-0.5">{item}</span>)}</div>}
      {body && <p className="mt-2 text-xs text-zinc-300 leading-5 whitespace-pre-wrap">{body}</p>}
      {actions && actions.length > 0 && <div className="mt-3 flex flex-wrap gap-2">{actions.map((action) => actionButton(action, onPromptSelect))}</div>}
    </div>
  );
}

function ListingBlock({ block, activeSource, onPromptSelect }: { block: WorkspaceBlock; activeSource: string | null; onPromptSelect?: (value: string) => void }) {
  const items = filterBySource((block.items || block.results || block.cards || []) as any[], activeSource) as any[];
  return frame(
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-white">{block.title || "Results"}</div>
          {(block.subtitle || block.note) && <div className="text-xs text-zinc-500 mt-1">{block.subtitle || block.note}</div>}
        </div>
        {block.body && <div className="text-[10px] text-zinc-400">{block.body}</div>}
      </div>
      {items.length === 0 ? (
        <div className="text-sm text-zinc-500">{block.description || "No results."}</div>
      ) : (
        <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
          {items.slice(0, 10).map((item, index) => (
            <CompactCard
              key={item.fingerprint || item.id || `${block.type}-${index}`}
              title={item.building_name || item.name || item.title || "Listing"}
              subtitle={[
                item.bhk || item.intent || "",
                item.micro_market || item.location_label || item.area || "",
                item.broker_name || item.broker || "",
              ]
                .filter(Boolean)
                .join(" · ")}
              meta={[
                item.price_formatted ? String(item.price_formatted) : item.price ? `₹${Number(item.price || 0).toLocaleString("en-IN")}` : "",
                item.area_sqft ? `${Number(item.area_sqft).toLocaleString("en-IN")} sqft` : "",
                item.furnishing || item.furniture || "",
                item.last_seen_text || item.last_seen || item.latest_timestamp || "",
                item.confidence != null ? `Confidence ${item.confidence}%` : "",
                item.observation_count != null ? `${item.observation_count} sources` : item.source_count != null ? `${item.source_count} sources` : "",
              ].filter(Boolean)}
              body={[item.latest_message || item.description || item.body, item.location || item.address].filter(Boolean).join("\n")}
              actions={[
                ...(item.href ? [{ label: "Open", href: item.href }] : []),
                ...(item.url ? [{ label: "Open", href: item.url }] : []),
                { label: "Open Building", value: item.building_name || item.name || item.title || "Open Building" },
                { label: "Promote Listing", value: item.building_name || item.name || item.title || "Promote Listing" },
                ...(item.phone || item.broker_phone ? [{ label: "Call", value: item.phone || item.broker_phone }] : []),
                { label: "Save", value: item.building_name || item.name || item.title || "Save" },
              ].filter((action, idx, arr) => Boolean(action.label) && arr.findIndex((a) => a.label === action.label) === idx)}
              onPromptSelect={onPromptSelect}
            />
          ))}
          {items.length > 10 && <div className="text-[10px] text-zinc-500">+{items.length - 10} more shown in the current response</div>}
        </div>
      )}
    </div>,
  );
}

function TableBlock({ block, activeSource, onPromptSelect }: { block: WorkspaceBlock; activeSource: string | null; onPromptSelect?: (value: string) => void }) {
  const rows = filterBySource((block.rows || []) as any[], activeSource) as any[];
  const columns = block.columns || [];
  return frame(
    <div className="space-y-3">
      <div>
        <div className="text-sm font-semibold text-white">{block.title || "Workspace table"}</div>
        {block.subtitle && <div className="text-xs text-zinc-500 mt-1">{block.subtitle}</div>}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead>
            <tr className="border-b border-white/10">
              {columns.map((column) => (
                <th key={column} className="pb-2 pr-4 font-semibold text-zinc-400 uppercase tracking-wider text-[10px]">{column}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, idx) => (
              <tr key={idx} className="border-b border-white/5">
                {columns.map((column, colIdx) => (
                  <td key={`${idx}-${column}`} className="py-2 pr-4 text-white align-top">
                    {Array.isArray(row) ? String(row[colIdx] ?? "—") : String(row?.[column] ?? row?.[column.toLowerCase()] ?? "—")}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>,
  );
}

function TimelineBlock({ block, activeSource }: { block: WorkspaceBlock; activeSource: string | null }) {
  const items = filterBySource((block.events || block.items || []) as any[], activeSource) as any[];
  return frame(
    <div className="space-y-3">
      <div>
        <div className="text-sm font-semibold text-white">{block.title || "Timeline"}</div>
        {block.subtitle && <div className="text-xs text-zinc-500 mt-1">{block.subtitle}</div>}
      </div>
      <div className="space-y-3">
        {items.map((item, index) => (
          <div key={item.id || index} className="flex gap-3">
            <div className="flex flex-col items-center">
              <span className="w-2.5 h-2.5 rounded-full bg-blue-400 mt-1" />
              {index < items.length - 1 && <span className="w-px flex-1 bg-[rgba(255,255,255,0.08)] mt-1" />}
            </div>
            <div className="flex-1 pb-1">
              <div className="text-sm text-white font-medium">{item.title || item.label || "Event"}</div>
              {item.when && <div className="text-[10px] text-zinc-500 mt-0.5">{item.when}</div>}
              {item.body && <div className="text-xs text-zinc-300 mt-1 whitespace-pre-wrap">{item.body}</div>}
            </div>
          </div>
        ))}
      </div>
    </div>,
  );
}

function ComparisonBlock({ block, activeSource }: { block: WorkspaceBlock; activeSource: string | null }) {
  const items = filterBySource((block.items || []) as any[], activeSource) as any[];
  return frame(
    <div className="space-y-3">
      <div>
        <div className="text-sm font-semibold text-white">{block.title || "Comparison"}</div>
        {block.subtitle && <div className="text-xs text-zinc-500 mt-1">{block.subtitle}</div>}
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        {items.slice(0, 2).map((item, index) => (
          <CompactCard
            key={item.title || index}
            title={item.title || `Option ${index + 1}`}
            subtitle={item.subtitle}
            meta={(Array.isArray(item.metrics) ? item.metrics : []).map((metric: any) => `${metric.label}: ${metric.value}`)}
            body={item.body || item.description}
          />
        ))}
      </div>
    </div>,
  );
}

function MessageBlock({ block, activeSource }: { block: WorkspaceBlock; activeSource: string | null }) {
  const items = filterBySource((block.items || []) as any[], activeSource) as any[];
  return frame(
    <div className="space-y-3">
      <div>
        <div className="text-sm font-semibold text-white">{block.title || "Original messages"}</div>
        {block.subtitle && <div className="text-xs text-zinc-500 mt-1">{block.subtitle}</div>}
      </div>
      <div className="space-y-2">
        {items.map((item, index) => (
          <div key={item.id || index} className="rounded-lg border border-white/10 bg-[#0b1016] p-3">
            <div className="text-[10px] text-zinc-500 flex flex-wrap gap-x-2 gap-y-1">
              <span>{item.group_name || item.group || "WhatsApp"}</span>
              <span>{item.sender || item.broker_name || "Unknown"}</span>
              <span>{item.timestamp || item.when || ""}</span>
            </div>
            <div className="text-sm text-white mt-1 whitespace-pre-wrap">{item.message || item.body || item.text || "—"}</div>
          </div>
        ))}
      </div>
    </div>,
  );
}

function ChartBlock({ block, activeSource }: { block: WorkspaceBlock; activeSource: string | null }) {
  const items = filterBySource((block.items || []) as any[], activeSource) as any[];
  const max = Math.max(...items.map((item) => Number(item.value || item.count || 0)), 1);
  return frame(
    <div className="space-y-3">
      <div>
        <div className="text-sm font-semibold text-white">{block.title || "Chart"}</div>
        {block.subtitle && <div className="text-xs text-zinc-500 mt-1">{block.subtitle}</div>}
      </div>
      <div className="space-y-3">
        {items.map((item, index) => {
          const value = Number(item.value || item.count || 0);
          return (
            <div key={item.label || index}>
              <div className="flex items-center justify-between text-xs mb-1">
                <span className="text-zinc-300">{item.label || item.name || `Item ${index + 1}`}</span>
                <span className="text-zinc-400">{value}</span>
              </div>
              <div className="h-2 rounded-full bg-white/5 overflow-hidden">
                <div className="h-full rounded-full bg-blue-500/80" style={{ width: `${(value / max) * 100}%` }} />
              </div>
            </div>
          );
        })}
      </div>
    </div>,
  );
}

function MapBlock({ block, activeSource }: { block: WorkspaceBlock; activeSource: string | null }) {
  const items = filterBySource((block.items || []) as any[], activeSource) as any[];
  return frame(
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-white">{block.title || "Map"}</div>
          {block.subtitle && <div className="text-xs text-zinc-500 mt-1">{block.subtitle}</div>}
        </div>
        <div className="text-[10px] text-zinc-500">Map preview</div>
      </div>
      <div className="rounded-xl border border-white/10 bg-[#091018] p-4 min-h-40">
        <div className="grid grid-cols-2 gap-2">
          {items.slice(0, 6).map((item, index) => (
            <div key={item.id || index} className="rounded-lg border border-white/10 bg-white/5 p-2">
              <div className="text-sm text-white">{item.label || item.name || item.title || `Pin ${index + 1}`}</div>
              <div className="text-[10px] text-zinc-400 mt-1">{item.subtitle || item.location || item.address || "Listing pin"}</div>
            </div>
          ))}
        </div>
      </div>
    </div>,
  );
}

function PromotionPreviewBlock({ block }: { block: WorkspaceBlock }) {
  const channelMap: Record<string, any> = {};
  for (const channel of block.channels || []) {
    if (channel && typeof channel === "object" && channel.id) channelMap[channel.id] = channel;
  }
  const channels = [
    { id: "whatsapp", label: "WhatsApp", fallback: block.body || block.content || "" },
    { id: "facebook", label: "Facebook", fallback: block.description || block.summary || "" },
    { id: "instagram", label: "Instagram", fallback: block.note || "" },
  ];
  return frame(
    <div className="space-y-3">
      <div>
        <div className="text-sm font-semibold text-white">{block.title || "Promotion preview"}</div>
        {block.subtitle && <div className="text-xs text-zinc-500 mt-1">{block.subtitle}</div>}
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        {channels.map((channel) => {
          const payload = channelMap[channel.id] || {};
          const lines = [
            payload.message,
            payload.headline,
            payload.description,
            payload.highlights,
            payload.caption,
            payload.hashtags,
            payload.cta,
            channel.fallback,
          ].filter(Boolean);
          return (
            <div key={channel.id} className="rounded-xl border border-white/10 bg-[#0b1016] p-3">
              <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-2">{channel.label}</div>
              <div className="text-xs text-white whitespace-pre-wrap leading-5">{lines.join("\n\n") || "—"}</div>
            </div>
          );
        })}
      </div>
    </div>,
  );
}

function QuestionsBlock({ block, onPromptSelect }: { block: WorkspaceBlock; onPromptSelect?: (value: string) => void }) {
  const questions = (block.questions || block.items || []) as any[];
  return frame(
    <div className="space-y-3">
      <div>
        <div className="text-sm font-semibold text-white">{block.title || "Suggested questions"}</div>
        {block.subtitle && <div className="text-xs text-zinc-500 mt-1">{block.subtitle}</div>}
      </div>
      <div className="flex flex-wrap gap-2">
        {questions.map((question, index) => {
          const label = typeof question === "string" ? question : question.label || question.title || question.question || `Question ${index + 1}`;
          const value = typeof question === "string" ? question : question.value || question.prompt || question.label || label;
          return (
            <button
              key={label}
              onClick={() => onPromptSelect?.(value)}
              className="text-[10px] px-2.5 py-1 rounded border border-white/10 text-zinc-400 hover:text-white hover:border-blue-500/30 transition-colors"
            >
              {label}
            </button>
          );
        })}
      </div>
    </div>,
  );
}

function ExportPanelBlock({ block }: { block: WorkspaceBlock }) {
  const actions = (block.actions || []) as WorkspaceBlockAction[];
  const defaults = [
    { label: "Export CSV", value: "Export CSV" },
    { label: "Export Excel", value: "Export Excel" },
    { label: "Export PDF", value: "Export PDF" },
    { label: "Copy WhatsApp Summary", value: "Copy WhatsApp Summary" },
    { label: "Copy Email Summary", value: "Copy Email Summary" },
  ];
  return frame(
    <div className="space-y-3">
      <div>
        <div className="text-sm font-semibold text-white">{block.title || "Export"}</div>
        {block.subtitle && <div className="text-xs text-zinc-500 mt-1">{block.subtitle}</div>}
      </div>
      <div className="flex flex-wrap gap-2">{(actions.length ? actions : defaults).map((action) => actionButton(action, undefined))}</div>
    </div>,
  );
}

function GenericBlock({ block, onPromptSelect }: { block: WorkspaceBlock; onPromptSelect?: (value: string) => void }) {
  if (block.type === "error_state") {
    return frame(
      <div className="space-y-2">
        <div className="text-sm font-semibold text-rose-300">{block.title || "Something went wrong"}</div>
        <div className="text-sm text-zinc-300 whitespace-pre-wrap">{block.body || block.description || block.summary || "The assistant could not complete that request."}</div>
      </div>,
    );
  }
  if (block.type === "empty_state") {
    return frame(
      <div className="space-y-2">
        <div className="text-sm font-semibold text-white">{block.title || "No results"}</div>
        <div className="text-sm text-zinc-400 whitespace-pre-wrap">{block.body || block.description || block.summary || "Try a different query."}</div>
      </div>,
    );
  }
  if (block.type === "loading") {
    return frame(
      <div className="space-y-3">
        <div className="text-sm font-semibold text-white">{block.title || "Loading"}</div>
        <div className="space-y-2">
          {["w-3/4", "w-1/2", "w-5/6"].map((width) => (
            <div key={width} className={`h-3 rounded-full bg-white/5 ${width} animate-pulse`} />
          ))}
        </div>
      </div>,
    );
  }
  return SummaryBlock({ block, onPromptSelect });
}

function GreetingBlock({ block }: { block: WorkspaceBlock }) {
  return (
    <div className="text-sm text-zinc-200 whitespace-pre-wrap">
      {block.body || block.content || block.summary || ""}
    </div>
  );
}

function renderBlock(block: WorkspaceBlock, onPromptSelect?: (value: string) => void, index = 0, activeSource: string | null = null) {
  switch (block.type) {
    case "greeting":
      return <GreetingBlock key={`${block.type}-${index}`} block={block} />;
    case "summary":
      return <SummaryBlock key={`${block.type}-${index}`} block={block} onPromptSelect={onPromptSelect} />;
    case "listing_cards":
    case "related_listings":
    case "matching_buyers":
    case "buyer_cards":
    case "broker_cards":
    case "building_card":
    case "market_card":
      return <ListingBlock key={`${block.type}-${index}`} block={block} activeSource={activeSource} onPromptSelect={onPromptSelect} />;
    case "table":
      return <TableBlock key={`${block.type}-${index}`} block={block} activeSource={activeSource} onPromptSelect={onPromptSelect} />;
    case "timeline":
      return <TimelineBlock key={`${block.type}-${index}`} block={block} activeSource={activeSource} />;
    case "comparison":
      return <ComparisonBlock key={`${block.type}-${index}`} block={block} activeSource={activeSource} />;
    case "original_messages":
      return <MessageBlock key={`${block.type}-${index}`} block={block} activeSource={activeSource} />;
    case "ai_suggestions":
    case "suggested_questions":
      return <QuestionsBlock key={`${block.type}-${index}`} block={block} onPromptSelect={onPromptSelect} />;
    case "charts":
      return <ChartBlock key={`${block.type}-${index}`} block={block} activeSource={activeSource} />;
    case "export_panel":
      return <ExportPanelBlock key={`${block.type}-${index}`} block={block} />;
    case "promotion_preview":
      return <PromotionPreviewBlock key={`${block.type}-${index}`} block={block} />;
    case "map":
      return <MapBlock key={`${block.type}-${index}`} block={block} activeSource={activeSource} />;
    case "error_state":
    case "empty_state":
    case "loading":
    default:
      return <GenericBlock key={`${block.type}-${index}`} block={block} onPromptSelect={onPromptSelect} />;
  }
}

export default function AIWorkspace({ response, onPromptSelect }: Props) {
  const [selectedSource, setSelectedSource] = useState<string | null>(null);
  const rawBlocks = useMemo(() => response.blocks && response.blocks.length > 0
    ? response.blocks.map(sanitizeWorkspaceBlock)
    : (() => {
        const summary = summarizeContent(displayText(response.content || "No response."));
        return [{ type: "summary", title: "Workspace", ...summary }].map(sanitizeWorkspaceBlock);
      })(), [response.blocks, response.content]);
  const statusSteps = response.status_steps || [];
  const sources = useMemo(
    () => [...new Set([...(response.sources || []), ...(response.trace?.sources || [])].map((source) => sourceToken(source)).filter(Boolean))],
    [response.sources, response.trace?.sources],
  );
  const filteredBlocks = useMemo(
    () => rawBlocks.filter((block) => blockMatchesSource(block, selectedSource)),
    [rawBlocks, selectedSource],
  );
  const hasSourceFilter = Boolean(selectedSource);
  const isGreetingOnly = filteredBlocks.length > 0 && filteredBlocks.every((b) => b.type === "greeting");

  if (isGreetingOnly) {
    return <div className="text-sm text-zinc-200 whitespace-pre-wrap">{filteredBlocks.map((b) => b.body || b.content || "").join("\n")}</div>;
  }

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-white">Workspace</div>
          <div className="text-xs text-zinc-500 mt-1">Structured broker results rendered by PropAI</div>
        </div>
        <div className="text-[10px] text-zinc-500">{filteredBlocks.length} block{filteredBlocks.length === 1 ? "" : "s"}</div>
      </div>

      {statusSteps.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {statusSteps.map((step, index) => (
            <span key={`${step}-${index}`} className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[10px] text-zinc-300">
              {step}
            </span>
          ))}
        </div>
      )}

      {sources.length > 0 && (
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => setSelectedSource(null)}
            className={`rounded-full border px-3 py-1 text-[10px] transition-colors ${!hasSourceFilter ? "border-blue-500/30 bg-blue-500/10 text-blue-200" : "border-white/10 bg-white/5 text-zinc-300 hover:text-white"}`}
          >
            All sources
          </button>
          {sources.map((source) => (
            <button
              key={source}
              onClick={() => setSelectedSource((prev) => (prev === source ? null : source))}
              className={`rounded-full border px-3 py-1 text-[10px] transition-colors ${
                selectedSource === source
                  ? "border-blue-500/30 bg-blue-500/10 text-blue-200"
                  : "border-white/10 bg-white/5 text-zinc-300 hover:text-white"
              }`}
            >
              {sourceLabel(source)}
            </button>
          ))}
        </div>
      )}

      {hasSourceFilter && (
        <div className="text-[10px] text-zinc-500">
          Filtering to source: <span className="text-zinc-300">{selectedSource}</span>
        </div>
      )}

      {filteredBlocks.length === 0 ? (
        <div className="rounded-xl border border-white/10 p-4 text-sm text-zinc-400">
          No blocks match the selected source filter.
        </div>
      ) : (
        <div className="space-y-3">{filteredBlocks.map((block, index) => renderBlock(block, onPromptSelect, index, selectedSource))}</div>
      )}

      <div className="flex flex-wrap items-center gap-2 text-[10px] text-zinc-500">
        <span className="uppercase tracking-wider">Sources</span>
        {sources.map((source) => (
          <span key={source} className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5">{sourceLabel(source)}</span>
        ))}
      </div>
    </div>
  );
}
