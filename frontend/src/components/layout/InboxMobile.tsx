"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { useIsMobile } from "@/hooks/useMediaQuery";
import { X, ChevronLeft, ArrowUp } from "lucide-react";

export function useMobileInbox() {
  const isMobile = useIsMobile();
  const [mobileView, setMobileView] = useState<"list" | "conversation" | "analysis">("list");

  const showList = !isMobile || mobileView === "list";
  const showConversation = !isMobile || mobileView === "conversation";
  const showAnalysis = !isMobile || mobileView === "analysis";

  const goToConversation = useCallback(() => {
    if (isMobile) setMobileView("conversation");
  }, [isMobile]);

  const goToAnalysis = useCallback(() => {
    if (isMobile) setMobileView("analysis");
  }, [isMobile]);

  const goToList = useCallback(() => {
    if (isMobile) setMobileView("list");
  }, [isMobile]);

  return {
    isMobile,
    mobileView,
    setMobileView,
    showList,
    showConversation,
    showAnalysis,
    goToConversation,
    goToAnalysis,
    goToList,
  };
}

export function MobileInboxHeader({
  title,
  onBack,
  rightAction,
}: {
  title: string;
  onBack?: () => void;
  rightAction?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 px-3 py-2 border-b border-white/5 bg-black/90 min-h-[44px] lg:hidden">
      {onBack && (
        <button
          onClick={onBack}
          className="p-1 -ml-1 rounded-lg text-zinc-400 hover:text-white hover:bg-white/5 transition-colors touch-target"
          aria-label="Go back"
        >
          <ChevronLeft className="w-5 h-5" />
        </button>
      )}
      <h1 className="text-sm font-bold text-white truncate">{title}</h1>
      <div className="flex-1" />
      {rightAction}
    </div>
  );
}

export function MobileBottomSheet({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
}) {
  if (!open) return null;

  return (
    <>
      <div className="bottom-sheet-overlay lg:hidden" onClick={onClose} />
      <div className="bottom-sheet lg:hidden animate-in slide-up">
        <div className="sticky top-0 z-10 flex items-center justify-between px-4 py-3 border-b border-white/5 bg-[#0a0a0a] rounded-t-[20px]">
          <div className="flex items-center gap-2">
            <div className="w-8 h-1 rounded-full bg-zinc-600 mx-auto -mt-1 absolute left-1/2 -translate-x-1/2 top-1" />
            {title && <span className="text-sm font-semibold text-white">{title}</span>}
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg text-zinc-400 hover:text-white hover:bg-white/5 transition-colors"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-4 pb-8 max-h-[75vh] overflow-y-auto">
          {children}
        </div>
      </div>
    </>
  );
}
