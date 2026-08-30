"use client";

import { AssistantRuntimeProvider, ComposerPrimitive, MessagePrimitive, ThreadPrimitive, useLocalRuntime, type ChatModelAdapter } from "@assistant-ui/react";
import { Send } from "lucide-react";
import { useMemo, useState } from "react";
import { fetchJSON } from "@/lib/api";

type ChatMessage = { role: "user" | "assistant"; content: string };
type Props = { sessionId: string | null; agentReady: boolean; onError: (message: string) => void; context?: string; initialMessages?: ChatMessage[] };

function AssistantMessage() {
  return <MessagePrimitive.Root className="mb-4 flex justify-start"><div className="max-w-2xl rounded-xl border border-[var(--border)] bg-[var(--surface-raised)] px-3 py-2 text-sm text-[var(--text-secondary)]"><MessagePrimitive.Content /></div></MessagePrimitive.Root>;
}
function UserMessage() {
  return <MessagePrimitive.Root className="mb-4 flex justify-end"><div className="max-w-2xl rounded-xl bg-[var(--accent)]/15 px-3 py-2 text-sm text-[var(--text-primary)]"><MessagePrimitive.Content /></div></MessagePrimitive.Root>;
}

export function AssistantUiOpsChat({ sessionId, agentReady, onError, context, initialMessages = [] }: Props) {
  const [requestError, setRequestError] = useState<string | null>(null);
  const adapter = useMemo<ChatModelAdapter>(() => ({ async run({ messages }) {
    if (!sessionId) throw new Error("No active agent session");
    if (!agentReady) throw new Error("PropAI Ops is currently unavailable");
    const latest = messages.at(-1);
    const userPrompt = latest?.role === "user" ? latest.content.filter((part) => part.type === "text").map((part) => part.text).join(" ") : "";
    const prompt = context ? `${context}\n\nOperator request: ${userPrompt}` : userPrompt;
    try {
      setRequestError(null);
      const result = await fetchJSON<{ content: string }>("/admin/hermes/chat", { method: "POST", body: JSON.stringify({ prompt, session_id: sessionId, messages: messages.slice(0, -1).map((message) => ({ role: message.role, content: message.content.filter((part) => part.type === "text").map((part) => part.text).join(" ") })) }) }, 300000);
      return { content: [{ type: "text", text: result.content }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : "PropAI Operations Agent request failed";
      setRequestError(message);
      onError(message);
      throw error;
    }
  } }), [agentReady, context, onError, sessionId]);
  const runtime = useLocalRuntime(adapter, { initialMessages });
  return <AssistantRuntimeProvider runtime={runtime}><ThreadPrimitive.Root className="flex min-h-0 flex-1 flex-col">{requestError && <div className="mx-3 mt-3 rounded-lg border border-[#A9362E]/25 bg-[#FFF1EF] px-3 py-2 text-xs text-[#7D2B25]" role="alert">{requestError}</div>}<ThreadPrimitive.Viewport className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-5"><ThreadPrimitive.Messages components={{ AssistantMessage, UserMessage }} /></ThreadPrimitive.Viewport><ComposerPrimitive.Root className="flex shrink-0 items-end gap-2 border-t border-[var(--border)] p-3"><ComposerPrimitive.Input placeholder="Ask about PropAI, deployments, extraction, or data quality" className="min-h-11 flex-1 resize-none rounded-lg border border-[var(--border)] bg-[var(--surface-raised)] p-3 text-sm text-[var(--text-primary)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]" /><ComposerPrimitive.Send className="inline-flex h-10 w-10 items-center justify-center rounded-lg bg-[var(--accent)] text-[#102018] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"><Send className="h-4 w-4" /></ComposerPrimitive.Send></ComposerPrimitive.Root></ThreadPrimitive.Root></AssistantRuntimeProvider>;
}
