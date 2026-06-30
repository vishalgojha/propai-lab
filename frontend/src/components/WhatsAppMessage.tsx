"use client";

import React, { useMemo } from "react";

interface WhatsAppMessageProps {
  text: string;
  sender?: string;
  senderPhone?: string;
  className?: string;
  truncate?: boolean;
  maxLines?: number;
}

const SEPARATOR_RE = /^[•\-\*═─━~]{3,}\s*$/;

function isSeparatorLine(line: string): boolean {
  return SEPARATOR_RE.test(line.trim());
}

interface Card {
  type: "card";
  lines: string[];
}

interface SeparatorBlock {
  type: "separator";
}

type Block = Card | SeparatorBlock;

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
  className = "",
  truncate = false,
  maxLines = 2,
}: WhatsAppMessageProps) {
  if (!text) return null;

  const lines = text.split("\n");

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
        parts.push(remaining);
        break;
      }

      const earliest = matches.reduce((a, b) =>
        (a.match.index || 0) < (b.match.index || 0) ? a : b
      );

      const idx = earliest.match.index || 0;
      if (idx > 0) {
        parts.push(remaining.slice(0, idx));
      }

      const content = earliest.match[1];
      switch (earliest.type) {
        case "bold":
          parts.push(
            <strong key={key++} className="font-bold text-white">
              {content}
            </strong>
          );
          break;
        case "italic":
          parts.push(
            <em key={key++} className="italic text-[#94a3b8]">
              {content}
            </em>
          );
          break;
        case "strike":
          parts.push(
            <span key={key++} className="line-through text-[#64748b]">
              {content}
            </span>
          );
          break;
        case "code":
          parts.push(
            <code
              key={key++}
              className="bg-[#1e293b] px-1.5 py-0.5 rounded text-[#e2e8f0] text-[11px] font-mono"
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
        {isBullet && <span className="text-[#3b82f6] shrink-0">•</span>}
        {isNumbered && (
          <span className="text-[#3b82f6] shrink-0">
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

  const blocks = useMemo(() => groupIntoBlocks(lines), [text]);
  const multiBlock = blocks.length > 2;

  const containerClass = `whatsapp-message text-xs text-[#cbd5e1] leading-relaxed ${className}`;

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
              <div key={bi} className="my-1.5 border-t border-[rgba(255,255,255,0.06)]" />
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
            <div key={bi} className="my-2 border-t border-[rgba(255,255,255,0.08)]" />
          );
        }

        if (multiBlock) {
          return (
            <div
              key={bi}
              className="my-1.5 px-2.5 py-2 rounded-md bg-[rgba(255,255,255,0.02)] border border-[rgba(255,255,255,0.04)]"
            >
              {sender && (
                <div className="flex items-center gap-1.5 mb-1.5 pb-1.5 border-b border-[rgba(255,255,255,0.04)]">
                  <span className="text-[10px] font-semibold text-[#94a3b8]">{sender}</span>
                  {senderPhone && (
                    <span className="text-[9px] text-[#64748b] font-mono">{senderPhone}</span>
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
