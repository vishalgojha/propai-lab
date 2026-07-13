"use client";

import React, { useMemo } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Building2, MapPin, Phone, User, Users } from "lucide-react";
import * as api from "@/lib/api";
import { entityProfileHref, entityTooltip } from "@/lib/entity-links";

interface WhatsAppMessageProps {
  text: string;
  sender?: string;
  senderPhone?: string;
  entities?: MessageEntity[];
  onEntityClick?: (entity: MessageEntity) => boolean | void;
  className?: string;
  truncate?: boolean;
  maxLines?: number;
  flatMultiBlocks?: boolean;
}

const SEPARATOR_RE = /^[•\-\*═─━~]{3,}\s*$/;
const PHONE_RE = /(?:\+?91[\s-]*)?[6-9](?:[\s-]*\d){9}\b/g;
const LISTING_START_RE =
  /(?:^|[\s|,-])(?:\d+(?:\.\d+)?\s*)?(?:bhk|rk|bed)\b.*\bavailable\b.*\b(?:rent|sale|lease)\b|^\s*(?:hot\s+deal|urgent|new\s+building|exclusive)\b/i;

export type MessageEntityType =
  | "broker"
  | "firm"
  | "building"
  | "society"
  | "locality"
  | "landmark"
  | "phone"
  | "client"
  | "requirement"
  | "listing"
  | "developer";

export interface MessageEntity {
  type: MessageEntityType;
  text: string;
  id?: string | number;
  exists?: boolean;
  phone?: string;
  firm?: string;
  rawMessageId?: number;
  metadata?: Record<string, unknown>;
}

function isSeparatorLine(line: string): boolean {
  return SEPARATOR_RE.test(line.trim());
}

function isListingStartLine(line: string): boolean {
  const clean = line.trim();
  if (!clean) return false;
  return LISTING_START_RE.test(clean);
}

function normalizeMessageLines(text: string): string[] {
  return text
    .split("\n")
    .flatMap((line) =>
      line
        // Some WhatsApp exports collapse numbered listing items onto one line.
        // Put each item back on its own logical line before block detection.
        .replace(/\s+(\d+[\.)]\s+(?=[^\n]*\b(?:bhk|rk|bed|building|flat|office)\b))/gi, "\n$1")
        .split("\n")
    );
}

interface Card {
  type: "card";
  lines: string[];
}

interface SeparatorBlock {
  type: "separator";
}

type Block = Card | SeparatorBlock;
type PreviewData = {
  total_listings?: number;
  observation_count?: number;
  broker_count?: number;
  markets?: Array<string | { micro_market?: string }>;
  top_markets?: string[];
};

const ENTITY_LABELS: Record<MessageEntityType, string> = {
  broker: "Broker",
  firm: "Firm",
  building: "Building",
  society: "Society",
  locality: "Locality",
  landmark: "Landmark",
  phone: "Phone",
  client: "Client",
  requirement: "Requirement",
  listing: "Listing",
  developer: "Developer",
};

function entityIcon(type: MessageEntityType) {
  const cls = "w-3 h-3";
  switch (type) {
    case "broker":
    case "client":
      return <User className={cls} strokeWidth={1.8} />;
    case "firm":
      return <Users className={cls} strokeWidth={1.8} />;
    case "phone":
      return <Phone className={cls} strokeWidth={1.8} />;
    case "building":
    case "society":
    case "developer":
      return <Building2 className={cls} strokeWidth={1.8} />;
    default:
      return <MapPin className={cls} strokeWidth={1.8} />;
  }
}

function normalizeDigits(value: string) {
  const digits = value.replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("91")) return digits.slice(-10);
  if (digits.length === 11 && digits.startsWith("0")) return digits.slice(-10);
  return digits;
}

function entityKey(entity: MessageEntity) {
  return `${entity.type}:${String(entity.id || entity.phone || entity.text).toLowerCase()}`;
}

function dedupeEntities(entities: MessageEntity[]) {
  const seen = new Set<string>();
  return entities.filter((entity) => {
    const text = entity.text?.trim();
    if (!text) return false;
    const key = entityKey({ ...entity, text });
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function PreviewCard({ entity }: { entity: MessageEntity }) {
  const [data, setData] = React.useState<PreviewData | null>(null);
  const [loaded, setLoaded] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        let next: PreviewData | null = null;
        if (entity.type === "broker" || entity.type === "phone") {
          next = await api.getBrokerSummary(
            entity.type === "broker" ? entity.text : "",
            entity.phone || entity.text
          );
        } else if (entity.type === "building") {
          next = await api.getBuildingProfile(entity.text);
        } else if (entity.type === "locality") {
          next = await api.getMarketDetail(entity.text);
        }
        if (!cancelled) setData(next);
      } catch {
        if (!cancelled) setData(null);
      } finally {
        if (!cancelled) setLoaded(true);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [entity.text, entity.phone, entity.type]);

  const markets =
    data?.markets?.map((market) => (typeof market === "string" ? market : market.micro_market)).filter(Boolean) ||
    data?.top_markets ||
    [];

  return (
    <div className="absolute left-0 top-full z-50 mt-1.5 w-64 rounded-lg border border-white/10 p-3 text-left shadow-2xl">
      <div className="flex items-start gap-2">
        <span className="mt-0.5 text-[#3EE88A]">{entityIcon(entity.type)}</span>
        <div className="min-w-0">
          <div className="truncate text-[12px] font-bold text-white">{entity.text}</div>
          <div className="mt-0.5 text-[9px] uppercase tracking-wider text-zinc-500">
            {ENTITY_LABELS[entity.type]} {entity.exists === false ? "profile not yet created" : "profile"}
          </div>
        </div>
      </div>

      <div className="mt-3 space-y-1.5 text-[10px] text-zinc-400">
        {!loaded ? (
          <div>Loading preview...</div>
        ) : entity.exists === false ? (
          <div className="text-zinc-300">Create a lightweight profile from extracted messages.</div>
        ) : data ? (
          <>
            {typeof data.total_listings === "number" && (
              <div className="flex justify-between"><span>Listings</span><span className="text-white">{data.total_listings}</span></div>
            )}
            {typeof data.observation_count === "number" && (
              <div className="flex justify-between"><span>Observations</span><span className="text-white">{data.observation_count}</span></div>
            )}
            {typeof data.broker_count === "number" && (
              <div className="flex justify-between"><span>Active brokers</span><span className="text-white">{data.broker_count}</span></div>
            )}
            {markets.length > 0 && (
              <div>
                <div className="text-[9px] uppercase tracking-wider text-zinc-500">Markets</div>
                <div className="mt-0.5 text-white">{markets.slice(0, 3).join(", ")}</div>
              </div>
            )}
          </>
        ) : (
          <div className="text-zinc-300">Open search or create a linked entity.</div>
        )}
      </div>

      <div className="mt-3 border-t border-white/10 pt-2 text-[10px] font-semibold text-[#3EE88A]">
        {entity.exists === false ? "Create profile ->" : "Open profile ->"}
      </div>
    </div>
  );
}

function EntityLink({
  entity,
  children,
  onEntityClick,
}: {
  entity: MessageEntity;
  children: React.ReactNode;
  onEntityClick?: (entity: MessageEntity) => boolean | void;
}) {
  const router = useRouter();
  const [preview, setPreview] = React.useState(false);
  const href = entityProfileHref(entity);
  const title = entityTooltip(entity);

  return (
    <span
      className="relative inline-flex align-baseline"
      onMouseEnter={() => setPreview(true)}
      onMouseLeave={() => setPreview(false)}
    >
      <Link
        href={href}
        prefetch={false}
        onMouseEnter={() => router.prefetch(href)}
        onFocus={() => router.prefetch(href)}
        onClick={(event) => {
          event.stopPropagation();
          if (onEntityClick?.(entity)) {
            event.preventDefault();
          }
        }}
        className="inline-flex cursor-pointer items-center gap-1 rounded px-1 py-0.5 text-[#bfdbfe] underline decoration-[#3b82f6]/45 decoration-dotted underline-offset-2 hover:bg-[#1d4ed8]/20 hover:text-white"
        title={title}
        aria-label={title}
      >
        <span className="text-[#60a5fa]">{entityIcon(entity.type)}</span>
        <span>{children}</span>
      </Link>
      {preview && <PreviewCard entity={entity} />}
    </span>
  );
}

function groupIntoBlocks(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let currentCard: string[] = [];
  let consecutiveBlanks = 0;

  const flushCard = () => {
    if (currentCard.length > 0) {
      blocks.push({ type: "card", lines: [...currentCard] });
      currentCard = [];
    }
  };

  for (const line of lines) {
    if (isSeparatorLine(line)) {
      flushCard();
      blocks.push({ type: "separator" });
      consecutiveBlanks = 0;
    } else if (line.trim() === "") {
      consecutiveBlanks++;
      // Only flush on 2+ consecutive blank lines
      if (consecutiveBlanks >= 2) {
        flushCard();
      }
    } else {
      consecutiveBlanks = 0;
      if (currentCard.length > 0 && isListingStartLine(line)) {
        flushCard();
      }
      currentCard.push(line);
    }
  }

  flushCard();
  return blocks;
}

export default function WhatsAppMessage({
  text,
  sender,
  senderPhone,
  entities = [],
  onEntityClick,
  className = "",
  truncate = false,
  maxLines = 2,
  flatMultiBlocks = false,
}: WhatsAppMessageProps) {
  const allEntities = useMemo(() => {
    const detectedPhones: MessageEntity[] = [];
    for (const match of text.matchAll(PHONE_RE)) {
      detectedPhones.push({
        type: "phone",
        text: match[0],
        phone: normalizeDigits(match[0]).slice(-10),
        exists: true,
      });
    }
    return dedupeEntities([...entities, ...detectedPhones]).sort((a, b) => b.text.length - a.text.length);
  }, [entities, text]);

  const renderEntityText = (value: string, keyPrefix: string) => {
    const parts: React.ReactNode[] = [];
    let cursor = 0;

    while (cursor < value.length) {
      let best: { entity: MessageEntity; index: number; length: number } | null = null;
      const slice = value.slice(cursor);
      const lowerSlice = slice.toLowerCase();

      for (const entity of allEntities) {
        const entityText = entity.text.trim();
        if (!entityText) continue;
        const index = lowerSlice.indexOf(entityText.toLowerCase());
        if (index < 0) continue;
        const absoluteIndex = cursor + index;
        const before = absoluteIndex > 0 ? value[absoluteIndex - 1] : "";
        const after = value[absoluteIndex + entityText.length] || "";
        const boundaryOk =
          !/[A-Za-z0-9]/.test(before) &&
          (!/[A-Za-z0-9]/.test(after) || entity.type === "phone");
        if (!boundaryOk) continue;
        if (!best || absoluteIndex < best.index || (absoluteIndex === best.index && entityText.length > best.length)) {
          best = { entity, index: absoluteIndex, length: entityText.length };
        }
      }

      if (!best) {
        parts.push(value.slice(cursor));
        break;
      }

      if (best.index > cursor) {
        parts.push(value.slice(cursor, best.index));
      }

      const matchedText = value.slice(best.index, best.index + best.length);
      parts.push(
        <EntityLink
          key={`${keyPrefix}-entity-${parts.length}`}
          entity={{ ...best.entity, text: matchedText }}
          onEntityClick={onEntityClick}
        >
          {matchedText}
        </EntityLink>
      );
      cursor = best.index + best.length;
    }

    return parts;
  };

  const formatInline = (line: string) => {
    const parts: React.ReactNode[] = [];
    let remaining = line;
    let key = 0;

    while (remaining.length > 0) {
      const boldMatch = remaining.match(/\*([^*]+)\*/);
      const italicMatch = remaining.match(/_([^_]+)_/);
      const strikeMatch = remaining.match(/~([^~]+)~/);
      const codeMatch = remaining.match(/```([^`]+)```/);

      const matches = [
        boldMatch && { type: "bold", match: boldMatch },
        italicMatch && { type: "italic", match: italicMatch },
        strikeMatch && { type: "strike", match: strikeMatch },
        codeMatch && { type: "code", match: codeMatch },
      ].filter(Boolean) as { type: string; match: RegExpMatchArray }[];

      if (matches.length === 0) {
        parts.push(...renderEntityText(remaining, `plain-${key++}`));
        break;
      }

      const earliest = matches.reduce((a, b) =>
        (a.match.index || 0) < (b.match.index || 0) ? a : b
      );

      const idx = earliest.match.index || 0;
      if (idx > 0) {
        parts.push(...renderEntityText(remaining.slice(0, idx), `pre-${key++}`));
      }

      const content = earliest.match[1];
      switch (earliest.type) {
        case "bold":
          parts.push(
            <strong key={key++} className="font-bold text-white">
              {renderEntityText(content, `bold-${key}`)}
            </strong>
          );
          break;
        case "italic":
          parts.push(
            <em key={key++} className="italic text-zinc-400">
              {renderEntityText(content, `italic-${key}`)}
            </em>
          );
          break;
        case "strike":
          parts.push(
            <span key={key++} className="line-through text-zinc-500">
              {renderEntityText(content, `strike-${key}`)}
            </span>
          );
          break;
        case "code":
          parts.push(
            <code
              key={key++}
              className="bg-[#1e293b] px-1.5 py-0.5 rounded text-white text-[11px] font-mono"
            >
              {content}
            </code>
          );
          break;
      }

      remaining = remaining.slice(idx + earliest.match[0].length);
    }

    return parts;
  };

  const renderLine = (line: string, i: number) => {
    if (line.trim() === "") return null;

    const isBullet = /^[•\-\*]\s/.test(line);
    const isSubBullet = /^\s+[•\-\*]\s/.test(line);
    const isNumbered = /^\d+[\.\)]\s/.test(line);

    return (
      <div key={i} className={isBullet || isNumbered ? "flex gap-1.5 mt-0.5" : ""}>
        {isBullet && <span className="text-blue-400 shrink-0">•</span>}
        {isNumbered && (
          <span className="text-blue-400 shrink-0">
            {line.match(/^(\d+[\.\)]\s)/)?.[1]}
          </span>
        )}
        <span className={isSubBullet ? "ml-4" : ""}>
          {formatInline(
            isBullet
              ? line.replace(/^[•\-\*]\s/, "")
              : isNumbered
              ? line.replace(/^\d+[\.\)]\s/, "")
              : line
          )}
        </span>
      </div>
    );
  };

  const blocks = useMemo(() => groupIntoBlocks(normalizeMessageLines(text)), [text]);
  const multiBlock = blocks.length > 2;

  const containerClass = `whatsapp-message text-xs text-zinc-300 leading-relaxed ${className}`;

  if (!text) return null;

  if (truncate) {
    let lineCount = 0;
    const truncatedBlocks: Block[] = [];
    for (const block of blocks) {
      if (block.type === "separator") {
        truncatedBlocks.push(block);
        continue;
      }
      const remaining = maxLines - lineCount;
      if (remaining <= 0) break;
      truncatedBlocks.push({
        type: "card",
        lines: block.lines.slice(0, remaining),
      });
      lineCount += block.lines.slice(0, remaining).length;
    }
    return (
      <div className={`${containerClass} line-clamp-${maxLines}`}>
        {truncatedBlocks.map((block, bi) => {
          if (block.type === "separator") {
            return (
              <div key={bi} className="my-1.5 border-t border-white/10" />
            );
          }
          return (
            <div key={bi} className="space-y-0.5">
              {block.lines.map((line, li) => renderLine(line, bi * 1000 + li))}
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div className={containerClass}>
      {blocks.map((block, bi) => {
        if (block.type === "separator") {
          return (
            <div key={bi} className="my-2 border-t border-white/10" />
          );
        }

        if (multiBlock && !flatMultiBlocks) {
          return (
            <div
              key={bi}
              className="my-1.5 px-2.5 py-2 rounded-md bg-white/5 border border-white/5"
            >
              {sender && (
                <div className="flex items-center gap-1.5 mb-1.5 pb-1.5 border-b border-white/5">
                  <span className="text-[10px] font-semibold text-zinc-400">{sender}</span>
                  {senderPhone && (
                    <span className="text-[9px] text-zinc-500 font-mono">{senderPhone}</span>
                  )}
                </div>
              )}
              {block.lines.map((line, li) => renderLine(line, bi * 1000 + li))}
            </div>
          );
        }

        return (
          <div key={bi} className="space-y-0.5">
            {block.lines.map((line, li) => renderLine(line, bi * 1000 + li))}
          </div>
        );
      })}
    </div>
  );
}
