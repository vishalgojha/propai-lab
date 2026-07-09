"use client";

import { useEffect } from "react";
import { useParams, useRouter } from "next/navigation";

export default function ObservationSlugPage() {
  const params = useParams();
  const router = useRouter();

  useEffect(() => {
    if (params?.id) {
      router.replace(`/inbox?observation=${encodeURIComponent(params.id as string)}`);
    }
  }, [params, router]);

  return (
    <div className="min-h-screen bg-[#070b0e] flex items-center justify-center">
      <div className="text-xs text-zinc-500">Redirecting to observation...</div>
    </div>
  );
}
