"use client";

import dynamic from "next/dynamic";
import "mapbox-gl/dist/mapbox-gl.css";
import type { BuildingOnMap } from "@/lib/localities";

const LocalityMap = dynamic(() => import("./LocalityMap"), {
  ssr: false,
  loading: () => (
    <div className="w-full h-[420px] lg:h-[480px] rounded-xl border border-white/10 bg-zinc-900/50 animate-pulse" />
  ),
});

export default function LocalityMapLoader({
  locality,
  buildings,
  token,
}: {
  locality: string;
  buildings: BuildingOnMap[];
  token: string | null;
}) {
  return <LocalityMap locality={locality} buildings={buildings} token={token} />;
}
