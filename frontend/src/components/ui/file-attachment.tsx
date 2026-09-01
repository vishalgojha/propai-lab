"use client";

import { AlertCircle, Check, FileText, LoaderCircle, X } from "lucide-react";
import { cn } from "@/lib/utils";

export type FileAttachmentState = "idle" | "uploading" | "processing" | "error" | "done";

export function FileAttachment({
  name,
  meta,
  state = "done",
  previewUrl,
  onRemove,
  className,
}: {
  name: string;
  meta?: string;
  state?: FileAttachmentState;
  previewUrl?: string;
  onRemove?: () => void;
  className?: string;
}) {
  const status = state === "uploading" ? "Uploading…" : state === "processing" ? "Processing…" : state === "error" ? "Upload failed" : meta;
  return (
    <div className={cn("flex min-w-0 items-center gap-2 rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-2", state === "error" && "border-red-300/30 bg-red-300/10", className)}>
      <div className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-md border border-white/10 bg-white/[0.05] text-zinc-400">
        {previewUrl ? <img src={previewUrl} alt="" className="h-full w-full object-cover" /> : <FileText className="h-4 w-4" aria-hidden="true" />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs font-medium text-zinc-200" title={name}>{name}</div>
        <div className={cn("truncate text-[10px] text-zinc-500", state === "error" && "text-red-200", (state === "uploading" || state === "processing") && "text-amber-200")}>{status}</div>
      </div>
      {state === "uploading" || state === "processing" ? <LoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin text-amber-300" aria-label={status} /> : state === "error" ? <AlertCircle className="h-3.5 w-3.5 shrink-0 text-red-300" aria-hidden="true" /> : state === "done" && !onRemove ? <Check className="h-3.5 w-3.5 shrink-0 text-emerald-300" aria-hidden="true" /> : onRemove ? <button type="button" onClick={onRemove} className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-white/10 hover:text-white" aria-label={`Remove ${name}`}><X className="h-3.5 w-3.5" /></button> : null}
    </div>
  );
}

export function FileAttachmentGroup({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("flex max-w-full gap-2 overflow-x-auto pb-1", className)} role="group" aria-label="Attachments">{children}</div>;
}
