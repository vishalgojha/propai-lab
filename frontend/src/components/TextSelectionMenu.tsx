"use client";

import React, { useEffect, useRef, useState, useCallback } from "react";

interface SelectionAction {
  id: string;
  label: string;
  icon: string;
  handler: (text: string, context: any) => void;
}

interface TextSelectionMenuProps {
  actions: SelectionAction[];
  context?: any;
  containerRef?: React.RefObject<HTMLElement | null>;
}

export default function TextSelectionMenu({ actions, context = {}, containerRef }: TextSelectionMenuProps) {
  const [visible, setVisible] = useState(false);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [selectedText, setSelectedText] = useState("");
  const [showFullMenu, setShowFullMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);

  // Detect text selection and show bubble instantly
  const handleSelection = useCallback(() => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.toString().trim()) {
      // Don't hide if clicking inside our menu
      if (menuRef.current && menuRef.current.contains(document.activeElement)) return;
      setVisible(false);
      setShowFullMenu(false);
      return;
    }

    const text = selection.toString().trim();
    if (text.length < 2) return;

    // Check if selection is inside our container
    const range = selection.getRangeAt(0);
    const container = containerRef?.current;
    if (container && !container.contains(range.commonAncestorContainer)) return;

    const rect = range.getBoundingClientRect();

    setSelectedText(text);
    setPosition({
      x: rect.left + rect.width / 2,
      y: rect.top - 8,
    });
    setVisible(true);
    setShowFullMenu(false);
  }, [containerRef]);

  // Prevent browser context menu inside message areas
  const handleContextMenu = useCallback((e: Event) => {
    const mouseEvent = e as MouseEvent;
    const container = containerRef?.current;
    if (container && container.contains(mouseEvent.target as Node)) {
      // Only prevent if there's a text selection
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed && selection.toString().trim()) {
        e.preventDefault();
        // Show our menu at cursor position
        const text = selection.toString().trim();
        if (text.length >= 2) {
          setSelectedText(text);
          setPosition({ x: mouseEvent.clientX, y: mouseEvent.clientY });
          setVisible(true);
          setShowFullMenu(true);
        }
      }
    }
  }, [containerRef]);

  // Handle Shift+RightClick to show native browser menu
  const handleShiftContextMenu = useCallback((e: Event) => {
    const mouseEvent = e as MouseEvent;
    if (mouseEvent.shiftKey) {
      // Allow native context menu
      return;
    }
  }, []);

  // Click outside to dismiss
  const handleMouseDown = useCallback((e: Event) => {
    const mouseEvent = e as MouseEvent;
    if (menuRef.current && !menuRef.current.contains(mouseEvent.target as Node) &&
        bubbleRef.current && !bubbleRef.current.contains(mouseEvent.target as Node)) {
      setVisible(false);
      setShowFullMenu(false);
    }
  }, []);

  useEffect(() => {
    const target = containerRef?.current || document;
    target.addEventListener("mouseup", handleSelection);
    target.addEventListener("contextmenu", handleContextMenu);
    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("selectionchange", handleSelection);

    return () => {
      target.removeEventListener("mouseup", handleSelection);
      target.removeEventListener("contextmenu", handleContextMenu);
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("selectionchange", handleSelection);
    };
  }, [handleSelection, handleContextMenu, handleMouseDown, containerRef]);

  // Keyboard shortcut: Cmd/Ctrl + Shift + A
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === "a") {
        e.preventDefault();
        handleSelection();
        setShowFullMenu(true);
      }
      if (e.key === "Escape") {
        setVisible(false);
        setShowFullMenu(false);
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [handleSelection]);

  if (!visible || !selectedText) return null;

  return (
    <>
      {/* Action Bubble - appears instantly beside selection */}
      {!showFullMenu && (
        <div
          ref={bubbleRef}
          className="fixed z-[9999] animate-in fade-in zoom-in duration-100"
          style={{
            left: position.x,
            top: position.y,
            transform: "translate(-50%, -100%)",
          }}
        >
          <button
            onClick={(e) => {
              e.stopPropagation();
              setShowFullMenu(true);
            }}
            className="flex items-center gap-1 px-2.5 py-1 bg-gradient-to-r from-blue-600 to-purple-600 text-white text-[11px] font-bold rounded-full shadow-lg shadow-blue-500/20 hover:from-blue-500 hover:to-purple-500 transition-all active:scale-95"
          >
            <span className="text-xs">✨</span>
            <span>PropAI</span>
          </button>
        </div>
      )}

      {/* Full Action Menu */}
      {showFullMenu && (
        <div
          ref={menuRef}
          className="fixed z-[9999] animate-in fade-in slide-in-from-bottom-1 duration-100"
          style={{
            left: Math.min(position.x, window.innerWidth - 260),
            top: Math.max(position.y - 10, 10),
            transform: "translate(-50%, -100%)",
          }}
        >
          <div className="w-60 bg-zinc-900 border border-white/10 rounded-xl shadow-2xl shadow-black/50 overflow-hidden backdrop-blur-xl">
            {/* Selection Preview */}
            <div className="px-3 py-2 border-b border-white/10 bg-white/5">
              <div className="text-[9px] text-zinc-500 uppercase tracking-wider font-bold mb-0.5">Selected</div>
              <div className="text-[10px] text-zinc-400 truncate leading-snug">
                &ldquo;{selectedText.slice(0, 70)}{selectedText.length > 70 ? "..." : ""}&rdquo;
              </div>
            </div>

            {/* Actions */}
            <div className="py-1">
              {actions.map((action, i) => {
                if (action.id.startsWith("sep")) {
                  return i > 0 ? (
                    <div key={action.id} className="h-px bg-[rgba(255,255,255,0.08)] mx-3 my-1" />
                  ) : null;
                }
                return (
                  <button
                    key={action.id}
                    onClick={(e) => {
                      e.stopPropagation();
                      action.handler(selectedText, context);
                      setVisible(false);
                      setShowFullMenu(false);
                      window.getSelection()?.removeAllRanges();
                    }}
                    className="w-full text-left px-3 py-2 text-[11px] text-white hover:bg-[rgba(59,130,246,0.1)] flex items-center gap-2.5 transition-colors group"
                  >
                    <span className="text-sm w-5 text-center">{action.icon}</span>
                    <span className="group-hover:text-white">{action.label}</span>
                  </button>
                );
              })}
            </div>

            {/* Footer hint */}
            <div className="px-3 py-1.5 border-t border-white/10 bg-[rgba(255,255,255,0.01)]">
              <div className="text-[8px] text-zinc-500 flex items-center gap-1">
                <kbd className="px-1 py-0.5 bg-[rgba(255,255,255,0.05)] rounded text-[7px]">⇧</kbd>
                <span>+Right-click for browser menu</span>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
