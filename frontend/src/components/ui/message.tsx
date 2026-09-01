import * as React from "react";
import { cn } from "@/lib/utils";

const Message = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement> & { align?: "start" | "end" }>(
  ({ align = "start", className, ...props }, ref) => (
    <div ref={ref} data-align={align} className={cn("flex w-full gap-3", align === "end" && "justify-end", className)} {...props} />
  ),
);
Message.displayName = "Message";

const MessageAvatar = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn("mt-1 flex shrink-0 items-start text-lg", className)} {...props} />
));
MessageAvatar.displayName = "MessageAvatar";

const MessageContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn("min-w-0", className)} {...props} />
));
MessageContent.displayName = "MessageContent";

const MessageHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn("mb-1 text-xs text-zinc-400", className)} {...props} />
));
MessageHeader.displayName = "MessageHeader";

const MessageFooter = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn("mt-1 text-xs text-zinc-500", className)} {...props} />
));
MessageFooter.displayName = "MessageFooter";

export { Message, MessageAvatar, MessageContent, MessageHeader, MessageFooter };
