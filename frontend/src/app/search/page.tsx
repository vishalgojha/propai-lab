"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function SearchRedirect() {
  const router = useRouter();
  useEffect(() => { router.replace("/chat"); }, [router]);
  return <div className="text-center text-[#64748b] py-16">Redirecting to AI Chat...</div>;
}
