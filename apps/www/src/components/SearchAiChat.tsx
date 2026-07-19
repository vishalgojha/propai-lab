"use client";

import { useState, useRef, useEffect } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { Sparkles, Send, X } from "lucide-react";

function messageText(message: { parts?: Array<{ type?: string; text?: string }>; content?: string }) {
  if (typeof message.content === "string" && message.content) return message.content;
  return (message.parts || [])
    .map((part) => (part?.type === "text" ? part.text || "" : ""))
    .join("");
}

export default function SearchAiChat({ context }: { context: string }) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const endRef = useRef<HTMLDivElement>(null);

  const { messages, sendMessage, status, error } = useChat({
    transport: new DefaultChatTransport({
      api: "/api/ai-chat",
      body: () => ({ context }),
    }),
  });

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, status]);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-2 rounded-full bg-green-400 px-4 py-2 text-sm font-semibold text-black transition-colors hover:bg-green-300"
      >
        <Sparkles className="h-4 w-4" aria-hidden="true" />
        Ask AI
      </button>
    );
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || status === "submitted" || status === "streaming") return;
    sendMessage({ text });
    setInput("");
  }

  return (
    <div className="rounded-2xl border border-green-400/20 bg-zinc-950/90 p-4 lg:p-5">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2 text-sm font-semibold text-white">
          <Sparkles className="h-4 w-4 text-green-400" aria-hidden="true" />
          Ask AI about these results
        </div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-zinc-500 hover:text-white transition-colors"
          aria-label="Close AI chat"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="max-h-[360px] overflow-y-auto space-y-3 mb-3 pr-1">
        {messages.length === 0 ? (
          <p className="text-sm text-zinc-500">
            Ask anything about the listings above — e.g. “Which is best for a small family?” or “Compare the 2 BHK options.”
          </p>
        ) : (
          messages.map((m, i) => (
            <div key={m.id || i} className={`flex gap-2 ${m.role === "user" ? "justify-end" : ""}`}>
              {m.role === "assistant" && <Sparkles className="h-4 w-4 mt-1 shrink-0 text-green-400" aria-hidden="true" />}
              <div
                className={
                  m.role === "user"
                    ? "max-w-[80%] rounded-2xl bg-green-400 px-4 py-2.5 text-sm text-black whitespace-pre-wrap"
                    : "max-w-[90%] text-sm text-zinc-300 whitespace-pre-wrap leading-relaxed"
                }
              >
                {messageText(m)}
              </div>
            </div>
          ))
        )}
        {(status === "submitted" || status === "streaming") && (
          <div className="flex gap-2">
            <Sparkles className="h-4 w-4 mt-1 shrink-0 text-green-400" aria-hidden="true" />
            <div className="flex items-center gap-1.5 text-zinc-500 text-sm">
              <span className="h-1.5 w-1.5 rounded-full bg-zinc-500 animate-bounce [animation-delay:-0.3s]" />
              <span className="h-1.5 w-1.5 rounded-full bg-zinc-500 animate-bounce [animation-delay:-0.15s]" />
              <span className="h-1.5 w-1.5 rounded-full bg-zinc-500 animate-bounce" />
            </div>
          </div>
        )}
        {error && (
          <div className="text-sm text-red-300 bg-red-900/20 border border-red-500/20 rounded-2xl px-4 py-2.5">
            {error instanceof Error ? error.message : "Something went wrong. Try again."}
          </div>
        )}
        <div ref={endRef} />
      </div>

      <form onSubmit={submit} className="flex gap-2 items-end">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit(e);
            }
          }}
          placeholder="Ask about these listings..."
          rows={2}
          className="flex-1 resize-none bg-black/60 border border-white/10 rounded-xl px-3 py-2.5 text-sm text-white placeholder:text-zinc-500 focus:border-green-400 focus:outline-none"
        />
        <button
          type="submit"
          disabled={status === "submitted" || status === "streaming" || !input.trim()}
          className="px-4 py-2.5 bg-green-400 hover:bg-green-300 disabled:opacity-40 rounded-xl text-sm font-semibold text-black"
        >
          <Send className="h-4 w-4" />
        </button>
      </form>
    </div>
  );
}
