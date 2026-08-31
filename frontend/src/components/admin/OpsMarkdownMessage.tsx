"use client";

import type { ReactNode } from "react";

function inlineMarkdown(value: string): ReactNode {
  const tokens = value.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return tokens.map((token, index) => {
    if (token.startsWith("**") && token.endsWith("**")) {
      return <strong key={index} className="font-semibold text-[var(--text-primary)]">{token.slice(2, -2)}</strong>;
    }
    if (token.startsWith("`") && token.endsWith("`")) {
      return <code key={index} className="rounded bg-[var(--surface-raised)] px-1 py-0.5 text-[12px] text-[var(--accent)]">{token.slice(1, -1)}</code>;
    }
    return <span key={index}>{token}</span>;
  });
}

export function OpsMarkdownMessage({ content }: { content: string }) {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index].trim();
    if (!line) { index += 1; continue; }

    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      const Tag = level === 1 ? "h2" : level === 2 ? "h3" : "h4";
      blocks.push(<Tag key={`heading-${index}`} className={`${level <= 2 ? "mt-4 text-sm" : "mt-3 text-[13px]"} font-semibold text-[var(--text-primary)] first:mt-0`}>{inlineMarkdown(heading[2])}</Tag>);
      index += 1;
      continue;
    }

    const listMatch = line.match(/^[-*]\s+(.+)$/);
    if (listMatch) {
      const items: string[] = [];
      while (index < lines.length) {
        const item = lines[index].trim().match(/^[-*]\s+(.+)$/);
        if (!item) break;
        items.push(item[1]);
        index += 1;
      }
      blocks.push(<ul key={`list-${index}`} className="my-2 list-disc space-y-1 pl-5">{items.map((item, itemIndex) => <li key={itemIndex}>{inlineMarkdown(item)}</li>)}</ul>);
      continue;
    }

    const numberedMatch = line.match(/^\d+[.)]\s+(.+)$/);
    if (numberedMatch) {
      const items: string[] = [];
      while (index < lines.length) {
        const item = lines[index].trim().match(/^\d+[.)]\s+(.+)$/);
        if (!item) break;
        items.push(item[1]);
        index += 1;
      }
      blocks.push(<ol key={`ordered-${index}`} className="my-2 list-decimal space-y-1 pl-5">{items.map((item, itemIndex) => <li key={itemIndex}>{inlineMarkdown(item)}</li>)}</ol>);
      continue;
    }

    const paragraph: string[] = [line];
    index += 1;
    while (index < lines.length && lines[index].trim() && !/^(#{1,4})\s+|^[-*]\s+|^\d+[.)]\s+/.test(lines[index].trim())) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    blocks.push(<p key={`paragraph-${index}`} className="my-2 whitespace-pre-wrap leading-6">{inlineMarkdown(paragraph.join(" "))}</p>);
  }

  return <div className="space-y-1">{blocks}</div>;
}
