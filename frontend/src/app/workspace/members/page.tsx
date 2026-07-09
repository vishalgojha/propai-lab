"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function WorkspaceMembersRedirect() {
  const router = useRouter();
  useEffect(() => { router.replace("/profile/team"); }, [router]);
  return <div className="p-8 text-zinc-500">Redirecting to Team…</div>;
}
