"use client";

import { useState, useRef, useEffect } from "react";
import * as api from "@/lib/api";

const STORAGE_KEY = "propai_dw_key";

function getStoredKey(): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem(STORAGE_KEY) || "";
}

function setStoredKey(key: string) {
  localStorage.setItem(STORAGE_KEY, key);
}

interface Message {
  role: "user" | "assistant";
  content: string;
}

export default function ChatPage() {
  const [apiKey, setApiKey] = useState(getStoredKey);
  const [showKeyInput, setShowKeyInput] = useState(!getStoredKey());
  const [keyInput, setKeyInput] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  function handleSaveKey() {
    if (keyInput.trim().length >= 10) {
      setStoredKey(keyInput.trim());
      setApiKey(keyInput.trim());
      setShowKeyInput(false);
      setKeyInput("");
    }
  }

  async function send() {
    const text = input.trim();
    if (!text || loading) return;
    setInput("");
    setError("");

    const userMsg: Message = { role: "user", content: text };
    const updated = [...messages, userMsg];
    setMessages(updated);
    setLoading(true);

    try {
      const res = await api.chatAIChat(updated, apiKey);
      const assistantMsg: Message = { role: "assistant", content: res.content };
      setMessages((prev) => [...prev, assistantMsg]);
    } catch (e: any) {
      const body = e.message || "Request failed";
      if (body.includes("api_key_required")) {
        setShowKeyInput(true);
        setError("API key required. Paste your Doubleword key below.");
      } else {
        setError(body);
      }
    } finally {
      setLoading(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  if (showKeyInput) {
    return (
      <div className="max-w-xl mx-auto mt-16">
        <div className="bg-[#0d1117] border border-[rgba(255,255,255,0.06)] rounded-2xl p-6">
          <h2 className="text-lg font-semibold mb-2">🤖 AI Chat — Setup</h2>
          <p className="text-sm text-[#94a3b8] mb-4">
            Ask questions about your scraped real estate data using{" "}
            <strong>Qwen3.6 35B</strong> via Doubleword.
          </p>
          {error && (
            <p className="text-sm text-red-400 mb-3">{error}</p>
          )}
          <input
            className="w-full px-3 py-2 rounded-lg bg-[#1a1f2e] border border-[rgba(255,255,255,0.1)] text-sm mb-3"
            placeholder="Paste your Doubleword API key (sh_... or dw_...)"
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
          />
          <button
            onClick={handleSaveKey}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded-lg text-sm font-medium"
          >
            Save & Start Chat
          </button>
          <p className="text-xs text-[#64748b] mt-3">
            Key is stored in your browser (localStorage). Never shared.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto flex flex-col h-[calc(100vh-7rem)]">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-lg font-semibold">🤖 AI Chat</h1>
          <p className="text-xs text-[#94a3b8]">
            Ask about your scraped real estate and property data
          </p>
        </div>
        <button
          onClick={() => setShowKeyInput(true)}
          className="text-xs text-[#94a3b8] hover:text-white underline"
        >
          Change API key
        </button>
      </div>

      <div className="flex-1 overflow-y-auto space-y-3 pr-2 mb-4">
        {messages.length === 0 && (
          <div className="text-center text-[#64748b] text-sm mt-16">
            <p className="mb-2">💡 Try asking:</p>
            <p className="italic">&ldquo;How many properties in Andheri?&rdquo;</p>
            <p className="italic">&ldquo;Show me 3 BHK listings under 2 Cr&rdquo;</p>
            <p className="italic">&ldquo;What is the average price in Bandra?&rdquo;</p>
          </div>
        )}
        {messages.map((m, i) => (
          <div
            key={i}
            className={`px-4 py-3 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap ${
              m.role === "user"
                ? "bg-blue-600/20 ml-12"
                : "bg-[#0d1117] border border-[rgba(255,255,255,0.06)] mr-12"
            }`}
          >
            {m.content}
          </div>
        ))}
        {loading && (
          <div className="bg-[#0d1117] border border-[rgba(255,255,255,0.06)] rounded-2xl px-4 py-3 mr-12 text-sm text-[#94a3b8]">
            Thinking…
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {error && (
        <p className="text-sm text-red-400 mb-2">{error}</p>
      )}

      <div className="flex gap-2">
        <textarea
          className="flex-1 px-4 py-2.5 rounded-xl bg-[#0d1117] border border-[rgba(255,255,255,0.1)] text-sm resize-none"
          rows={1}
          placeholder="Ask about your data…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={loading}
        />
        <button
          onClick={send}
          disabled={loading || !input.trim()}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 rounded-xl text-sm font-medium"
        >
          Send
        </button>
      </div>
    </div>
  );
}
