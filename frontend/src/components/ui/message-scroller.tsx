"use client";

import * as React from "react";
import { ArrowDown } from "lucide-react";
import { cn } from "@/lib/utils";

type MessageScrollerContextValue = {
  atEnd: boolean;
  hasNewMessages: boolean;
  scrollToLatest: (behavior?: ScrollBehavior) => void;
  markLatestSeen: () => void;
  onScroll: () => void;
  viewportRef: React.MutableRefObject<HTMLDivElement | null>;
};

const MessageScrollerContext = React.createContext<MessageScrollerContextValue | null>(null);

function useMessageScroller() {
  const context = React.useContext(MessageScrollerContext);
  if (!context) throw new Error("useMessageScroller must be used within MessageScrollerProvider");
  return context;
}

function MessageScrollerProvider({ children, className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  const viewportRef = React.useRef<HTMLDivElement | null>(null);
  const [atEnd, setAtEnd] = React.useState(true);
  const [hasNewMessages, setHasNewMessages] = React.useState(false);

  const onScroll = React.useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const nextAtEnd = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 48;
    setAtEnd(nextAtEnd);
    if (nextAtEnd) setHasNewMessages(false);
  }, []);

  const scrollToLatest = React.useCallback((behavior: ScrollBehavior = "smooth") => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    viewport.scrollTo({ top: viewport.scrollHeight, behavior });
    setAtEnd(true);
    setHasNewMessages(false);
  }, []);

  const markLatestSeen = React.useCallback(() => setHasNewMessages(false), []);

  const context = React.useMemo(() => ({ atEnd, hasNewMessages, scrollToLatest, markLatestSeen, onScroll, viewportRef }), [atEnd, hasNewMessages, markLatestSeen, onScroll, scrollToLatest]);

  return <MessageScrollerContext.Provider value={context}><div className={cn("relative flex min-h-0 flex-1 flex-col", className)} {...props}>{children}</div></MessageScrollerContext.Provider>;
}

const MessageScroller = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn("relative min-h-0 flex-1", className)} {...props} />
));
MessageScroller.displayName = "MessageScroller";

const MessageScrollerViewport = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(({ className, onScroll, ...props }, forwardedRef) => {
  const { viewportRef, onScroll: updatePosition } = useMessageScroller();
  return <div ref={(node) => { viewportRef.current = node; if (typeof forwardedRef === "function") forwardedRef(node); else if (forwardedRef) forwardedRef.current = node; }} onScroll={(event) => { onScroll?.(event); updatePosition(); }} className={cn("h-full overflow-y-auto overscroll-contain", className)} {...props} />;
});
MessageScrollerViewport.displayName = "MessageScrollerViewport";

const MessageScrollerContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn("min-h-full", className)} {...props} />
));
MessageScrollerContent.displayName = "MessageScrollerContent";

const MessageScrollerItem = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement> & { messageId?: string; scrollAnchor?: boolean }>(({ messageId, scrollAnchor, className, ...props }, ref) => (
  <div ref={ref} data-message-id={messageId} data-scroll-anchor={scrollAnchor ? "true" : undefined} className={cn(className)} {...props} />
));
MessageScrollerItem.displayName = "MessageScrollerItem";

function MessageScrollerButton({ className, children = "Jump to latest", ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const { atEnd, hasNewMessages, scrollToLatest } = useMessageScroller();
  if (atEnd && !hasNewMessages) return null;
  return <button type="button" onClick={() => scrollToLatest()} className={cn("absolute bottom-3 left-1/2 z-10 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-emerald-300/30 bg-[#172525]/95 px-3 py-1.5 text-xs font-medium text-emerald-100 shadow-lg shadow-black/30 backdrop-blur transition hover:border-emerald-300/50 hover:bg-[#203333] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300/60", className)} {...props}><ArrowDown className="h-3.5 w-3.5" aria-hidden="true" />{hasNewMessages ? "New messages" : children}</button>;
}

export { MessageScrollerProvider, MessageScroller, MessageScrollerViewport, MessageScrollerContent, MessageScrollerItem, MessageScrollerButton, useMessageScroller };
