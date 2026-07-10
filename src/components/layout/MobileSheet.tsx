"use client";

import { useEffect, useRef } from "react";
import { X } from "lucide-react";

export function MobileSheet({
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
  const sheetRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => { document.body.style.overflow = ""; };
  }, [open]);

  return (
    <>
      {open && (
        <div className="fixed inset-0 z-[500] flex flex-col bg-black lg:relative lg:inset-auto lg:z-auto lg:bg-transparent animate-in fade-in">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-white/5 lg:hidden">
            <h2 className="text-sm font-bold text-white truncate">{title || ""}</h2>
            <button
              onClick={onClose}
              className="p-2 -mr-2 rounded-lg text-zinc-400 hover:text-white hover:bg-white/5 transition-colors"
              aria-label="Close"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Content - full height on mobile, normal on desktop */}
          <div className="flex-1 overflow-y-auto lg:overflow-visible">
            <div className="lg:block">
              {children}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
