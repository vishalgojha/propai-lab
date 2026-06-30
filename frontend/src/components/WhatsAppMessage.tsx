"use client";

import React from "react";

interface WhatsAppMessageProps {
  text: string;
  className?: string;
  truncate?: boolean;
  maxLines?: number;
}

export default function WhatsAppMessage({
  text,
  className = "",
  truncate = false,
  maxLines = 2,
}: WhatsAppMessageProps) {
  if (!text) return null;

  const lines = text.split("\n");

  const formatInline = (line: string) => {
    // Split by formatting markers and render bold/italic
    const parts: React.ReactNode[] = [];
    let remaining = line;
    let key = 0;

    while (remaining.length > 0) {
      // Bold: *text*
      const boldMatch = remaining.match(/\*([^*]+)\*/);
      // Italic: _text_
      const italicMatch = remaining.match(/_([^_]+)_/);
      // Strikethrough: ~text~
      const strikeMatch = remaining.match(/~([^~]+)~/);
      // Code: ```text```
      const codeMatch = remaining.match(/```([^`]+)```/);

      // Find earliest match
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

  const renderedLines = lines.map((line, i) => {
    // Empty line = spacing
    if (line.trim() === "") {
      return <div key={i} className="h-2" />;
    }

    // Bullet points: • - * followed by space
    const isBullet = /^[•\-\*]\s/.test(line);
    const isSubBullet = /^\s+[•\-\*]\s/.test(line);
    const isNumbered = /^\d+\.\s/.test(line);

    return (
      <div key={i} className={isBullet || isNumbered ? "flex gap-1.5 mt-0.5" : ""}>
        {isBullet && <span className="text-[#3b82f6] shrink-0">•</span>}
        {isNumbered && <span className="text-[#3b82f6] shrink-0">{line.match(/^(\d+\.\s)/)?.[1]}</span>}
        <span className={isSubBullet ? "ml-4" : ""}>
          {formatInline(isBullet ? line.replace(/^[•\-\*]\s/, "") : isNumbered ? line.replace(/^\d+\.\s/, "") : line)}
        </span>
      </div>
    );
  });

  const containerClass = `whatsapp-message text-xs text-[#cbd5e1] leading-relaxed ${className}`;

  if (truncate) {
    return (
      <div
        className={`${containerClass} line-clamp-${maxLines}`}
        style={{ WebkitLineClamp: maxLines }}
      >
        {renderedLines.slice(0, maxLines + 1)}
      </div>
    );
  }

  return <div className={containerClass}>{renderedLines}</div>;
}
