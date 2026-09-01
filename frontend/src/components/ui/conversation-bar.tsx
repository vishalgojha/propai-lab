"use client";

import * as React from "react";
import { ArrowUp, Mic, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";

type ConversationBarProps = {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
  onToggleVoice: () => void;
  voiceActive: boolean;
  disabled?: boolean;
};

/** PropAI's ConversationBar: ElevenLabs-style voice/text composer backed by
 * the workspace's existing authenticated conversation session. */
export function ConversationBar({ value, onChange, onSubmit, onToggleVoice, voiceActive, disabled = false }: ConversationBarProps) {
  return (
    <form onSubmit={onSubmit} className="border-t border-white/10 px-4 py-3">
      <Card className="m-0 gap-0 border-[#385548] bg-[#07100c] p-0 shadow-none focus-within:border-emerald-300/60">
        <textarea
          rows={3}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="Ask Copilot anything…"
          aria-label="Message PropAI workspace agent"
          className="min-h-[5.5rem] w-full resize-none bg-transparent px-3 pt-3 text-sm leading-relaxed text-[#f3f8f5] outline-none placeholder:text-[#789286]"
          disabled={disabled}
        />
        <Separator className="bg-[#294238]" />
        <div className="flex items-center justify-between gap-2 p-2">
          <span className="px-1 text-[10px] text-[#a9bdb2]">Voice or text · Shift+Enter for a new line</span>
          <div className="flex items-center gap-1">
            <Button type="button" variant="ghost" size="sm" onClick={onToggleVoice} aria-label={voiceActive ? "Stop listening" : "Talk to the agent"} title={voiceActive ? "Stop listening" : "Talk to the agent"} className={voiceActive ? "bg-rose-400 text-[#2b0b0d] hover:bg-rose-300" : "text-emerald-300 hover:bg-[#19372a]"}>
              {voiceActive ? <Square className="h-3.5 w-3.5" /> : <Mic className="h-3.5 w-3.5" />}
            </Button>
            <Button type="submit" size="icon" disabled={disabled || !value.trim()} aria-label="Send message to PropAI" className="h-8 w-8 bg-[#8bcb68] text-[#16252b] hover:brightness-105">
              <ArrowUp className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </Card>
    </form>
  );
}
