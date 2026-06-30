"use client";

import React, { useEffect, useRef, useState, useCallback } from "react";

interface SelectionAction {
  id: string;
  label: string;
  icon: string;
  permission?: string;
  handler: (text: string, context: any) => void;
}

interface TextSelectionMenuProps {
  actions: SelectionAction[];
  context?: any;
  containerRef?: React.RefObject<HTMLElement>;
}

export default function TextSelectionMenu({ actions, context = {}, containerRef }: TextSelectionMenuProps) {
  const [visible, setVisible] = useState(false);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [selectedText, setSelectedText] = useState("");
  const menuRef = useRef<HTMLDivElement>(null);

  const handleSelection = useCallback(() => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.toString().trim()) {
      setVisible(false);
      return;
    }

    const text = selection.toString().trim();
    if (text.length < 3) return;

    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();

    setSelectedText(text);
    setPosition({
      x: rect.left + rect.width / 2,
      y: rect.top - 10,
    });
    setVisible(true);
  }, []);

  const handleClickOutside = useCallback((e: Event) => {
    if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
      setVisible(false);
    }
  }, []);

  useEffect(() => {
    const target = containerRef?.current || document;
    target.addEventListener("mouseup", handleSelection);
    target.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("selectionchange", handleSelection);

    return () => {
      target.removeEventListener("mouseup", handleSelection);
      target.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("selectionchange", handleSelection);
    };
  }, [handleSelection, handleClickOutside, containerRef]);

  // Keyboard shortcut: Cmd/Ctrl + Shift + A
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === "a") {
        e.preventDefault();
        handleSelection();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [handleSelection]);

  if (!visible || !selectedText) return null;

  return (
    <div
      ref={menuRef}
      className="fixed z-[9999] animate-in fade-in zoom-in duration-150"
      style={{
        left: position.x,
        top: position.y,
        transform: "translate(-50%, -100%)",
      }}
    >
      {/* PropAI Button */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          // Toggle menu
          const menu = document.getElementById("propai-action-menu");
          if (menu) {
            menu.style.display = menu.style.display === "none" ? "block" : "none";
          }
        }}
        className="flex items-center gap-1.5 px-3 py-1.5 bg-gradient-to-r from-blue-600 to-purple-600 text-white text-xs font-bold rounded-full shadow-lg hover:from-blue-500 hover:to-purple-500 transition-all"
      >
        <span>✨</span>
        <span>PropAI</span>
      </button>

      {/* Action Menu */}
      <div
        id="propai-action-menu"
        className="absolute left-1/2 -translate-x-1/2 mt-2 w-64 bg-[#0d1117] border border-[rgba(255,255,255,0.1)] rounded-xl shadow-2xl overflow-hidden hidden"
      >
        <div className="p-2 border-b border-[rgba(255,255,255,0.06)]">
          <div className="text-[10px] text-[#64748b] uppercase tracking-wider font-bold px-2">
            AI Actions
          </div>
        </div>
        <div className="py-1 max-h-80 overflow-y-auto">
          {actions.map((action) => (
            <button
              key={action.id}
              onClick={(e) => {
                e.stopPropagation();
                action.handler(selectedText, context);
                setVisible(false);
              }}
              className="w-full text-left px-3 py-2 text-xs text-[#e2e8f0] hover:bg-[rgba(255,255,255,0.05)] flex items-center gap-2.5 transition-colors"
            >
              <span className="text-sm">{action.icon}</span>
              <span>{action.label}</span>
            </button>
          ))}
        </div>
        <div className="p-2 border-t border-[rgba(255,255,255,0.06)] bg-[rgba(255,255,255,0.02)]">
          <div className="text-[9px] text-[#4a5568] truncate px-2">
            &quot;{selectedText.slice(0, 60)}{selectedText.length > 60 ? "..." : ""}&quot;
          </div>
        </div>
      </div>
    </div>
  );
}
