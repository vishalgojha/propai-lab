"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import * as api from "@/lib/api";
import AIWorkspace from "@/components/AIWorkspace";
import { Send, X, Sparkles, Loader2 } from "lucide-react";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  blocks?: any[];
}

interface InboxAIChatProps {
  context?: string;
  selectedMessage?: any;
  onClose?: () => void;
}

export function InboxAIChat({ context, selectedMessage, onClose }: InboxAIChatProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const [key, setKey] = useState("");
  const [model, setModel] = useState("");

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  useEffect(() => {
    if (typeof window !== "undefined") {
      setKey(localStorage.getItem("doubleword_key") || "");
      setModel(localStorage.getItem("doubleword_model") || "");
    }
  }, []);

  useEffect(() => {
    if (selectedMessage && messages.length === 0) {
      const contextMsg = `Context: ${selectedMessage.raw?.message || selectedMessage.message || "No message content"}`;
      setMessages([{ role: "assistant", content: "I have the context of the selected message. What would you like to know about it?" }]);
    }
  }, [selectedMessage]);

  const sendMessage = useCallback(async () => {
    if (!input.trim() || loading) return;
    const userMsg = input.trim();
    setInput("");
    setLoading(true);
    setError(null);

    const newUserMsg: ChatMessage = { role: "user", content: userMsg };
    setMessages((prev) => [...prev, newUserMsg]);

    try {
      const res = await api.chatAIChat([...messages, newUserMsg, { role: "user", content: userMsg }], key, model);
      if (res.content || res.blocks) {
        setMessages((prev) => [...prev, { role: "assistant", content: res.content || "", blocks: res.blocks }]);
      } else {
        setError("No response from AI");
      }
    } catch (e: any) {
      setError(e.message || "Failed to get AI response");
    } finally {
      setLoading(false);
    }
  }, [input, loading, messages, key, model]);

  if (onClose) {
    return (
      <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4">
        <div className="w-full max-w-2xl h-[80vh] rounded-2xl border border-white/10 flex flex-col overflow-hidden animate-in fade-in zoom-in-95">
          <div className="flex items-center justify-between p-4 border-b border-white/10">
            <div className="flex items-center gap-3">
              <Sparkles className="w-5 h-5 text-emerald-400" />
              <div>
                <div className="font-semibold text-white">PropAI Assistant</div>
                <div className="text-xs text-zinc-500">Ask about the selected message</div>
              </div>
            </div>
            <button onClick={onClose} className="p-2 rounded-lg text-zinc-400 hover:text-white hover:bg-white/5 transition-colors">
              <X className="w-5 h-5" />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            {messages.map((msg, idx) => (
              <div key={idx} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                <div className={`max-w-[85%] rounded-2xl px-4 py-3 ${msg.role === "user" ? "bg-emerald-400 text-black" : "border border-white/10"}`}>
                  {msg.blocks ? (
                    <AIWorkspace response={{ blocks: msg.blocks, content: msg.content, sources: [] }} />
                  ) : (
                    <p className="text-sm whitespace-pre-wrap">{msg.content}</p>
                  )}
                </div>
              </div>
            ))}
            {error && (
              <div className="text-red-400 text-sm text-center">{error}</div>
            )}
            <div ref={messagesEndRef} />
          </div>
          <div className="p-4 border-t border-white/10">
            <div className="flex gap-2">
              <input
                ref={(el) => { el?.focus(); }}
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && (e.preventDefault(), sendMessage())}
                placeholder="Ask about the message..."
                className="flex-1 bg-zinc-900 border border-white/10 rounded-xl px-4 py-3 text-sm text-white placeholder-zinc-500 focus:border-emerald-400/50 focus:outline-none focus:ring-1 focus:ring-emerald-400/50 transition-colors"
                disabled={loading}
              />
              <button
                onClick={sendMessage}
                disabled={loading || !input.trim()}
                className="px-6 py-3 bg-emerald-400 text-black rounded-xl font-semibold hover:bg-emerald-300 disabled:opacity-50 transition-colors flex items-center gap-2"
              >
                <Send className="w-4 h-4" />
                {loading && <Loader2 className="w-4 h-4 animate-spin" />}
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col rounded-xl border border-white/10">
      <div className="flex items-center justify-between p-3 border-b border-white/10">
        <div className="flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-emerald-400" />
          <span className="text-sm font-medium text-white">AI Assistant</span>
        </div>
        {onClose && (
          <button onClick={onClose} className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-white/5 transition-colors">
            <X className="w-4 h-4" />
          </button>
        )}
      </div>
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {messages.map((msg, idx) => (
          <div key={idx} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
            <div className={`max-w-[85%] rounded-2xl px-4 py-3 ${msg.role === "user" ? "bg-emerald-400 text-black" : "border border-white/10"}`}>
              {msg.blocks ? (
                <AIWorkspace response={{ blocks: msg.blocks, content: msg.content, sources: [] }} />
              ) : (
                <p className="text-sm whitespace-pre-wrap">{msg.content}</p>
              )}
            </div>
          </div>
        ))}
        {error && (
          <div className="text-red-400 text-xs text-center px-3">{error}</div>
        )}
        <div ref={messagesEndRef} />
      </div>
      <div className="p-3 border-t border-white/10">
        <div className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && (e.preventDefault(), sendMessage())}
            placeholder="Ask about the message..."
            className="flex-1 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white placeholder-zinc-500 focus:border-emerald-400/50 focus:outline-none focus:ring-1 focus:ring-emerald-400/50 transition-colors"
            disabled={loading}
          />
          <button
            onClick={sendMessage}
            disabled={loading || !input.trim()}
            className="px-5 py-2.5 bg-emerald-400 text-black rounded-xl font-semibold hover:bg-emerald-300 disabled:opacity-50 transition-colors flex items-center gap-1.5"
          >
            <Send className="w-3.5 h-3.5" />
            {loading && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
          </button>
        </div>
      </div>
    </div>
  );
}

export default InboxAIChat;