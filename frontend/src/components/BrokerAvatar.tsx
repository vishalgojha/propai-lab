"use client";

import { useProfilePicture } from "@/lib/useProfilePicture";
import { User } from "lucide-react";

export default function BrokerAvatar({
  phone,
  size = "md",
  className = "",
}: {
  phone?: string | null;
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  const jid = phone ? `${phone}@s.whatsapp.net` : "";
  const { url } = useProfilePicture(jid);

  const sizeClasses = {
    sm: "h-6 w-6",
    md: "h-9 w-9",
    lg: "h-12 w-12",
  }[size];

  const iconSize = { sm: "w-3 h-3", md: "w-4 h-4", lg: "w-5 h-5" }[size];

  return (
    <div
      className={`${sizeClasses} rounded-full border border-white/10 bg-white/[0.035] text-zinc-300 flex items-center justify-center overflow-hidden shrink-0 ${className}`}
    >
      {url ? (
        <img src={url} alt="" className="h-full w-full object-cover" />
      ) : (
        <User className={iconSize} strokeWidth={1.5} />
      )}
    </div>
  );
}
