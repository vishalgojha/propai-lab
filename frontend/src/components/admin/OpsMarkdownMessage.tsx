"use client";

import type { ReactNode } from "react";
import { useState } from "react";
import { Check, LoaderCircle, ShieldCheck } from "lucide-react";
import { fetchJSON } from "@/lib/api";

type DatabaseApproval = { token: string; operation: string; summary: string; table?: string; row_id?: string; function_name?: string; values?: Record<string, unknown>; arguments?: Record<string, unknown> };

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
  const approvalMatch = content.match(/\[\[PROPAI_APPROVAL\]\]([\s\S]*?)\[\[\/PROPAI_APPROVAL\]\]/);
  let approval: DatabaseApproval | null = null;
  if (approvalMatch) {
    try { approval = JSON.parse(approvalMatch[1]) as typeof approval; } catch { approval = null; }
  }
  const visibleContent = approvalMatch ? content.replace(approvalMatch[0], "").trim() : content;
  const lines = visibleContent.replace(/\r\n/g, "\n").split("\n");
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

  return <div className="space-y-1">{blocks}{approval && <DatabaseApprovalCard approval={approval} />}</div>;
}

function DatabaseApprovalCard({ approval }: { approval: DatabaseApproval }) {
  const [state, setState] = useState<"pending" | "busy" | "approved" | "error">("pending");
  const [message, setMessage] = useState("");
  const label = approval.operation === "run_function" ? `Run ${approval.function_name || "database function"}` : approval.operation.replace("_", " ");
  async function approve() {
    setState("busy"); setMessage("");
    try { await fetchJSON("/admin/ops/database/approve", { method: "POST", body: JSON.stringify({ token: approval.token }) }); setState("approved"); }
    catch (error) { setState("error"); setMessage(error instanceof Error ? error.message.replace(/^\d+\s[^:]+:\s*/, "") : "The approved action could not be completed."); }
  }
  return <div className="mt-3 rounded-lg border border-amber-400/35 bg-amber-400/8 p-3 text-xs text-[var(--text-secondary)]">
    <div className="flex items-center gap-2 font-medium text-[var(--text-primary)]"><ShieldCheck className="h-4 w-4 text-amber-300" /> Approval required</div>
    <p className="mt-1 leading-5">{approval.summary}</p>
    <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-[var(--text-muted)]"><span>{label}</span>{approval.table && <span>Table: <code>{approval.table}</code></span>}{approval.row_id && <span>Row: <code>{approval.row_id}</code></span>}</div>
    {state === "approved" ? <div className="mt-3 flex items-center gap-1.5 text-[var(--accent)]"><Check className="h-3.5 w-3.5" /> Approved and completed</div> : <><button type="button" onClick={() => void approve()} disabled={state === "busy"} className="mt-3 inline-flex items-center gap-1.5 rounded-md bg-[var(--accent)] px-2.5 py-1.5 font-medium text-[#07120c] disabled:opacity-50">{state === "busy" && <LoaderCircle className="h-3.5 w-3.5 animate-spin" />} Approve action</button>{state === "error" && <p className="mt-2 text-red-300">{message}</p>}</>}
  </div>;
}
