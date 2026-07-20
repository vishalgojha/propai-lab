"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import WhatsWowDrawer from "@/components/WhatsWowDrawer";

export default function WhatsWowPage() {
  const router = useRouter();

  useEffect(() => {
    // When drawer closes (user presses Escape or backdrop), go back
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") router.push("/inbox");
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [router]);

  return (
    <div className="h-[calc(100dvh-104px)] lg:h-full flex items-center justify-center">
      <WhatsWowDrawer open onClose={() => router.push("/inbox")} />
    </div>
  );
}
