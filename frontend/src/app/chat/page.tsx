"use client";

export const dynamic = 'force-dynamic';

import * as api from "@/lib/api";
import { useEffect, useState, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";

function buildChipLabels(s: api.ChatSuggestions | null): string[] {
  const chips: string[] = [];
  if (s?.top_supply_market) chips.push(`Owner listings in ${s.top_supply_market}`);
  if (s?.top_demand_market) chips.push(`Requirements in ${s.top_demand_market}`);
  if (s?.top_commercial_market) chips.push(`Who deals in ${s.top_commercial_market} offices?`);
  if (s?.top_building) chips.push(`Show all ${s.top_building} listings`);
  if (s?.top_rental_market) chips.push(`Brokers active in ${s.top_rental_market} rentals`);
  chips.push("Duplicate brokers in database");
  if (s?.top_broker_building) chips.push(`Which brokers post ${s.top_broker_building} most?`);
  chips.push("Show me this week's price trends");
  return chips;
}

function messageText(message: { content?: string; parts?: Array<{ type?: string; text?: string }> }) {
  if (typeof message.content === "string" && message.content) return message.content;
  return (message.parts || [])
    .map((part) => (part?.type === "text" ? part.text || "" : ""))
    .join("");
}

export default function ChatPage() {
  const [input, setInput] = useState("");
  const [suggestionsData, setSuggestionsData] = useState<api.ChatSuggestions | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const { messages, sendMessage, status, setMessages, error } = useChat({
    transport: new DefaultChatTransport({ api: "/api/ai/chat" }),
  });

  useEffect(() => {
    api.getChatSuggestions().then(setSuggestionsData).catch(() => {});
  }, []);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, status]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim() || status === "submitted") return;
    sendMessage({ text: input.trim() });
    setInput("");
  }

  return (
    <div className="max-w-4xl mx-auto px-4 lg:px-0">
      <style>{`
        @keyframes typing-bounce {
          0%, 80%, 100% { transform: translateY(0); }
          40% { transform: translateY(-6px); }
        }
        .typing-dot { width: 6px; height: 6px; border-radius: 50%; background: #a1a1aa; animation: typing-bounce 1.4s infinite both; }
        .typing-dot:nth-child(1) { animation-delay: -0.32s; }
        .typing-dot:nth-child(2) { animation-delay: -0.16s; }
        .typing-dot:nth-child(3) { animation-delay: 0s; }
      `}</style>

      <div className="flex flex-col h-[calc(100dvh-160px)] lg:h-[calc(100vh-160px)]">
        {messages.length > 0 && (
          <div className="mb-3 flex justify-end">
            <button
              onClick={() => setMessages([])}
              disabled={status === "submitted" || status === "streaming"}
              className="rounded-lg border border-white/10 px-3 py-1.5 text-xs font-medium text-zinc-400 hover:border-red-500/30 hover:text-red-200 disabled:opacity-40"
            >
              Clear chat
            </button>
          </div>
        )}

        <div className="flex-1 overflow-y-auto space-y-3 mb-4 pr-2">
          {messages.length === 0 ? (
            <div className="text-center py-12">
              <div className="text-3xl mb-3">🤖</div>
              <h2 className="text-sm font-semibold text-white mb-2">Ask PropAI anything</h2>
              <p className="text-xs text-zinc-500 mb-6 max-w-md mx-auto">
                Natural-language search across market listings, requirements, brokers, buildings, and markets.
              </p>
              <div className="flex flex-wrap gap-2 justify-center max-w-lg mx-auto">
                {buildChipLabels(suggestionsData).map((q) => (
                  <button
                    key={q}
                    onClick={() => setInput(q)}
                    className="text-xs text-zinc-400 border border-white/10 hover:border-blue-500/30 hover:text-white rounded-lg px-2.5 py-1.5 lg:px-3 lg:py-2 transition-colors min-h-[36px]"
                  >
                    {q}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <AnimatePresence initial={false}>
              {messages.map((m, i) => (
                <motion.div
                  key={m.id || i}
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.25, ease: "easeOut" }}
                  className={`flex gap-3 ${m.role === "user" ? "justify-end" : ""}`}
                >
                  {m.role === "assistant" && <span className="text-lg mt-1">🤖</span>}
                  {m.role === "user" ? (
                    <div className="max-w-[80%] rounded-xl px-4 py-2.5 text-sm bg-blue-600 text-white whitespace-pre-wrap">
                      {messageText(m)}
                    </div>
                  ) : (
                    <div className="max-w-[90%] w-full">
                      <div className="text-sm text-zinc-300 whitespace-pre-wrap leading-relaxed">{messageText(m)}</div>
                    </div>
                  )}
                  {m.role === "user" && <span className="text-lg mt-1">👤</span>}
                </motion.div>
              ))}
            </AnimatePresence>
          )}

          {(status === "submitted" || status === "streaming") && (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.2 }}
              className="flex gap-3"
            >
              <span className="text-lg mt-1">🤖</span>
              <div className="bg-zinc-900 border border-white/10 rounded-xl px-4 py-3 text-sm text-zinc-400 flex items-center gap-1.5 min-w-[60px]">
                <span className="typing-dot" />
                <span className="typing-dot" />
                <span className="typing-dot" />
              </div>
            </motion.div>
          )}

          {error && (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.2 }}
              className="flex gap-3"
            >
              <span className="text-lg mt-1">⚠️</span>
              <div className="bg-red-900/20 border border-red-500/20 rounded-xl px-4 py-2.5 text-sm text-red-300">
                {error instanceof Error ? error.message : "Something went wrong"}
              </div>
            </motion.div>
          )}

          <div ref={chatEndRef} />
        </div>

        <form onSubmit={handleSubmit} className="flex gap-2 items-end border-t border-white/10 pt-3 lg:pt-4 pb-2 lg:pb-0">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSubmit(e);
              }
            }}
            placeholder="Ask a question about your market data..."
            rows={2}
            className="flex-1 bg-zinc-900 border border-white/10 rounded-xl px-3 lg:px-4 py-2.5 text-sm text-white placeholder-[#64748b] resize-none max-h-[120px]"
          />
          <button
            type="submit"
            disabled={status === "submitted" || status === "streaming" || !input.trim()}
            className="px-3 lg:px-4 py-2.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 rounded-xl text-sm font-medium min-h-[44px]"
          >
            Send
          </button>
        </form>
      </div>
    </div>
  );
}
