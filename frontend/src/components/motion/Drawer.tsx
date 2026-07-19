"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useEffect } from "react";

interface DrawerProps {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  /** "right" slides a panel in from the right; "center" fades a centered dialog. */
  variant?: "right" | "center";
  /** Max width class for the panel (right variant). */
  widthClass?: string;
  /** Background surface class for the panel. */
  panelClass?: string;
  labelledBy?: string;
}

// Shared modal/drawer shell used by PromoteModal, SourceDrawer and
// AddToClientBucket. Provides a fading backdrop + sliding panel with proper
// enter/exit transitions via AnimatePresence. Escape closes; body scroll is
// locked while open. Respects prefers-reduced-motion (framer-motion's
// `useReducedMotion` is honoured automatically through the transition).
export default function Drawer({
  open,
  onClose,
  children,
  variant = "right",
  widthClass = "max-w-3xl",
  panelClass = "bg-[var(--color-bg-surface)] border-l border-[var(--color-border-strong)]",
  labelledBy,
}: DrawerProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  const reduceMotion = useReducedMotion();

  const panelMotion = reduceMotion
    ? { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 } }
    : variant === "right"
      ? { initial: { x: "100%" }, animate: { x: 0 }, exit: { x: "100%" } }
      : { initial: { opacity: 0, scale: 0.96, y: 8 }, animate: { opacity: 1, scale: 1, y: 0 }, exit: { opacity: 0, scale: 0.96, y: 8 } };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className={`fixed inset-0 z-50 bg-black/60 ${variant === "center" ? "flex items-center justify-center p-4" : ""}`}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2, ease: "easeOut" }}
          onClick={onClose}
        >
          <motion.div
            {...panelMotion}
            transition={{ duration: 0.28, ease: [0.4, 0, 0.2, 1] }}
            onClick={(e) => e.stopPropagation()}
            className={
              variant === "right"
                ? `absolute right-0 top-0 h-full w-full ${widthClass} overflow-y-auto ${panelClass} shadow-2xl`
                : `relative z-10 w-full ${widthClass} ${panelClass} rounded-2xl shadow-2xl my-auto`
            }
            role="dialog"
            aria-modal="true"
            aria-labelledby={labelledBy}
          >
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
