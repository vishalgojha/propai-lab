"use client";

import React, { useState, useRef, useCallback, useEffect } from "react";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";

interface ResizablePanelProps {
  children: React.ReactNode;
  defaultWidth: number;
  minWidth?: number;
  maxWidth?: number;
  storageKey?: string;
  collapsed?: boolean;
  onCollapse?: () => void;
  onExpand?: () => void;
  presets?: { label: string; width: number }[];
  className?: string;
  mobile?: boolean;
}

export default function ResizablePanel({
  children,
  defaultWidth,
  minWidth = 200,
  maxWidth = 800,
  storageKey,
  collapsed: controlledCollapsed,
  onCollapse,
  onExpand,
  presets = [
    { label: "Compact", width: 280 },
    { label: "Default", width: 384 },
    { label: "Deep Analysis", width: 560 },
  ],
  className = "",
  mobile = false,
}: ResizablePanelProps) {
  const [internalCollapsed, setInternalCollapsed] = useState(false);
  const collapsed = controlledCollapsed !== undefined ? controlledCollapsed : internalCollapsed;
  const [width, setWidth] = useState(defaultWidth);
  const [isDragging, setIsDragging] = useState(false);
  const [showPresets, setShowPresets] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);

  // On mobile, render full-width with no resizer / presets / collapse chrome
  if (mobile) {
    return (
      <div className={`relative flex flex-col w-full ${className}`}>
        {children}
      </div>
    );
  }


  useEffect(() => {
    if (!storageKey) return;
    const stored = localStorage.getItem(storageKey);
    if (!stored) return;
    const parsed = parseInt(stored, 10);
    if (!isNaN(parsed) && parsed >= minWidth && parsed <= maxWidth) {
      setWidth(parsed);
    }
  }, [storageKey, minWidth, maxWidth]);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setIsDragging(true);
      startXRef.current = e.clientX;
      startWidthRef.current = width;
    },
    [width]
  );

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!isDragging) return;
      const delta = e.clientX - startXRef.current;
      const newWidth = Math.min(maxWidth, Math.max(minWidth, startWidthRef.current + delta));
      setWidth(newWidth);
    },
    [isDragging, minWidth, maxWidth]
  );

  const handleMouseUp = useCallback(() => {
    if (isDragging) {
      setIsDragging(false);
      if (storageKey) {
        localStorage.setItem(storageKey, String(width));
      }
    }
  }, [isDragging, storageKey, width]);

  useEffect(() => {
    if (isDragging) {
      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      return () => {
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };
    }
  }, [isDragging, handleMouseMove, handleMouseUp]);

  const handleDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setShowPresets((prev) => !prev);
    },
    []
  );

  const selectPreset = useCallback(
    (presetWidth: number) => {
      setWidth(presetWidth);
      setShowPresets(false);
      if (storageKey) {
        localStorage.setItem(storageKey, String(presetWidth));
      }
      if (collapsed && onExpand) {
        onExpand();
        setInternalCollapsed(false);
      }
    },
    [storageKey, collapsed, onExpand]
  );

  const toggleCollapse = useCallback(() => {
    if (collapsed) {
      if (onExpand) onExpand();
      setInternalCollapsed(false);
    } else {
      if (onCollapse) onCollapse();
      setInternalCollapsed(true);
    }
  }, [collapsed, onCollapse, onExpand]);

  if (collapsed) {
    return (
      <div className={`relative flex flex-col ${className}`} style={{ width: 48, minWidth: 48 }}>
        <button
          onClick={toggleCollapse}
          className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-10 w-8 h-8 rounded-md bg-zinc-800 border border-white/10 text-zinc-500 hover:text-white hover:border-[#3EE88A]/40 transition-all flex items-center justify-center"
          title="Expand panel"
        >
          <PanelLeftOpen className="w-3.5 h-3.5" strokeWidth={1.5} />
        </button>
      </div>
    );
  }

  return (
    <div
      ref={panelRef}
      className={`relative flex flex-col ${className}`}
      style={{ width, minWidth: width, maxWidth: width }}
    >
      {children}

      {/* Divider */}
      <div
        onMouseDown={handleMouseDown}
        onDoubleClick={handleDoubleClick}
        className="absolute top-0 right-0 w-[5px] h-full cursor-col-resize group z-20 flex items-center justify-center"
      >
        <div className="w-[1px] h-full bg-[rgba(255,255,255,0.06)] group-hover:bg-[#3EE88A]/40 transition-colors" />
        <div className="absolute w-2 h-8 rounded-full bg-transparent group-hover:bg-[#3EE88A]/20 transition-colors" />
      </div>

      {/* Collapse button */}
      <button
        onClick={toggleCollapse}
        className="absolute top-2 right-3 z-30 w-5 h-5 rounded bg-zinc-800 border border-white/10 text-zinc-500 hover:text-white hover:border-[#3EE88A]/30 transition-all flex items-center justify-center opacity-0 group-hover:opacity-100"
        style={{ opacity: isDragging ? 0 : undefined }}
        title="Collapse panel"
      >
        <PanelLeftClose className="w-3 h-3" strokeWidth={1.5} />
      </button>

      {/* Preset dropdown */}
      {showPresets && (
        <div
          className="absolute top-10 right-3 z-40 bg-zinc-800 border border-white/10 rounded-lg shadow-xl overflow-hidden"
          onMouseLeave={() => setShowPresets(false)}
        >
          {presets.map((preset) => (
            <button
              key={preset.label}
              onClick={() => selectPreset(preset.width)}
              className={`w-full text-left px-4 py-2 text-[11px] hover:bg-[rgba(255,255,255,0.05)] transition-colors flex items-center justify-between gap-6 ${
                width === preset.width ? "text-[#3EE88A]" : "text-zinc-400"
              }`}
            >
              <span>{preset.label}</span>
              <span className="text-[10px] text-zinc-500 font-mono">{preset.width}px</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
