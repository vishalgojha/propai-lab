"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import type { AuditGroupCard, AuditGroupOverlapPair } from "@/lib/api";
import { cleanGroupName } from "@/lib/whatsapp-display";
import { designTokens } from "@/lib/design-tokens";

/* ── Types ─────────────────────────────────────────────────────────────── */

interface SimNode {
  jid: string;
  name: string;
  senders: number;
  locality: string | null;
  x: number;
  y: number;
  vx: number;
  vy: number;
  fx: number | null;
  fy: number | null;
}

interface SimEdge {
  source: string;
  target: string;
  shared: number;
  overlapPct: number;
}

/* ── Color palette ─────────────────────────────────────────────────────── */

// Categorical chart colors from the shared design tokens (Phase 4).
const PALETTE = designTokens.datavizCategorical;

function buildLocalityColorMap(groups: { locality: string | null }[]) {
  const locals = [...new Set(groups.map((g) => g.locality).filter(Boolean) as string[])].sort();
  const map = new Map<string, string>();
  locals.forEach((name, i) => {
    map.set(name, PALETTE[i % PALETTE.length]);
  });
  return map;
}

// Stable hash so a node without a known locality still gets a consistent,
// distinct color (instead of every such node collapsing to the grey fallback).
function hashIndex(key: string, mod: number): number {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return h % mod;
}

// Resolve a node color: locality color when available, otherwise a stable
// per-node color derived from its jid so the graph isn't one flat colour.
function nodeColor(node: SimNode, localityColorMap: Map<string, string>): string {
  if (node.locality) return localityColorMap.get(node.locality) ?? PALETTE[hashIndex(node.jid, PALETTE.length)];
  return PALETTE[hashIndex(node.jid, PALETTE.length)];
}

function numFmt(n: number) {
  return n.toLocaleString("en-IN");
}

function nodeRadius(senders: number, maxSenders: number) {
  const minR = 18;
  const maxR = 52;
  if (maxSenders <= 0) return minR;
  return minR + (maxR - minR) * Math.sqrt(senders / maxSenders);
}

/* ── Component ──────────────────────────────────────────────────────────── */

export default function NetworkMap({
  groups,
  pairs,
  uniqueMembers,
  redundantCount,
}: {
  groups: AuditGroupCard[];
  pairs: AuditGroupOverlapPair[];
  uniqueMembers: number;
  redundantCount: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const transformRef = useRef({ x: 0, y: 0, k: 1 });
  const selectedRef = useRef<string | null>(null);
  const hoveredRef = useRef<string | null>(null);

  const [, forceRender] = useState(0);
  const rerender = useCallback(() => forceRender((n) => n + 1), []);

  const [selected, setSelectedRaw] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [tooltip, setTooltip] = useState<{ x: number; y: number; node: SimNode; connected: number } | null>(null);

  const setSelected = useCallback((jid: string | null) => {
    selectedRef.current = jid;
    setSelectedRaw(jid);
  }, []);

  const sortedGroups = useMemo(
    () => [...groups].sort((a, b) => b.senders_count - a.senders_count),
    [groups],
  );

  const visibleGroups = showAll ? sortedGroups : sortedGroups.slice(0, 20);
  const visibleJids = useMemo(() => new Set(visibleGroups.map((g) => g.jid)), [visibleGroups]);

  const localityColorMap = useMemo(
    () => buildLocalityColorMap(visibleGroups.map((g) => ({ locality: g.parsed?.area || null }))),
    [visibleGroups],
  );

  const { nodes, edges } = useMemo(() => {
    const ns: SimNode[] = visibleGroups.map((g, i) => {
      // Deterministic seed positions on a circle so the simulation settles
      // predictably instead of jumping around from random starts.
      const angle = (i / Math.max(1, visibleGroups.length)) * Math.PI * 2;
      const r = 160 + (i % 5) * 24;
      return {
        jid: g.jid,
        name: g.name,
        senders: g.senders_count,
        locality: g.parsed?.area || null,
        x: 400 + Math.cos(angle) * r,
        y: 260 + Math.sin(angle) * r,
        vx: 0,
        vy: 0,
        fx: null,
        fy: null,
      };
    });
    const es: SimEdge[] = [];
    for (const p of pairs) {
      if (visibleJids.has(p.group_a.jid) && visibleJids.has(p.group_b.jid)) {
        es.push({
          source: p.group_a.jid,
          target: p.group_b.jid,
          shared: p.shared_senders,
          overlapPct: p.overlap_pct,
        });
      }
    }
    return { nodes: ns, edges: es };
  }, [visibleGroups, visibleJids, pairs]);

  const connectionsMap = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const e of edges) {
      if (!map.has(e.source)) map.set(e.source, new Set());
      if (!map.has(e.target)) map.set(e.target, new Set());
      map.get(e.source)!.add(e.target);
      map.get(e.target)!.add(e.source);
    }
    return map;
  }, [edges]);

  const overlappingPairs = useMemo(() => {
    if (!selected) return [];
    return pairs
      .filter((p) => p.group_a.jid === selected || p.group_b.jid === selected)
      .sort((a, b) => b.shared_senders - a.shared_senders)
      .slice(0, 5);
  }, [selected, pairs]);

  const selectedNode = selected ? nodes.find((n) => n.jid === selected) ?? null : null;
  const focus = hoveredRef.current ?? selected;

  /* ── Canvas draw function ──────────────────────────────────────────── */

  const drawRef = useRef<((canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D) => void) | null>(null);

  drawRef.current = (canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D) => {
    const { width, height } = canvas;
    const t = transformRef.current;
    const maxSenders = Math.max(1, ...nodes.map((n) => n.senders));
    const focusNode = hoveredRef.current ?? selectedRef.current;
    const connected = focusNode ? connectionsMap.get(focusNode) ?? new Set<string>() : new Set<string>();

    ctx.clearRect(0, 0, width, height);
    ctx.save();
    ctx.translate(t.x, t.y);
    ctx.scale(t.k, t.k);

    /* Edges */
    for (const e of edges) {
      const src = nodes.find((n) => n.jid === e.source);
      const tgt = nodes.find((n) => n.jid === e.target);
      if (!src || !tgt) continue;
      const isFocusEdge = focusNode && (e.source === focusNode || e.target === focusNode);
      const dim = focusNode && !isFocusEdge;
      const thickness = Math.max(1, (e.overlapPct / 100) * 5);
      const opacity = dim ? 0.04 : isFocusEdge ? 0.85 : Math.max(0.12, (e.overlapPct / 100) * 0.5);

      ctx.beginPath();
      ctx.moveTo(src.x, src.y);
      ctx.lineTo(tgt.x, tgt.y);
      ctx.strokeStyle = isFocusEdge ? "rgba(255,255,255,0.7)" : "rgba(161,161,170,0.5)";
      ctx.globalAlpha = opacity;
      ctx.lineWidth = isFocusEdge ? thickness * 1.5 : thickness;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    /* Nodes */
    for (const n of nodes) {
      const isFocus = focusNode === n.jid;
      const isConnected = connected.has(n.jid);
      const dim = focusNode && !isFocus && !isConnected;
      const r = nodeRadius(n.senders, maxSenders);
      const color = nodeColor(n, localityColorMap);

      ctx.globalAlpha = dim ? 0.15 : 1;

      if (isFocus) {
        ctx.beginPath();
        ctx.arc(n.x, n.y, r + 8, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.2;
        ctx.fill();
        ctx.globalAlpha = 1;
      }

      ctx.beginPath();
      ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
      ctx.fillStyle = isFocus ? color : `${color}dd`;
      ctx.fill();
      ctx.strokeStyle = isFocus ? "#ffffff" : `${color}66`;
      ctx.lineWidth = isFocus ? 2.5 : 1.2;
      ctx.stroke();

      ctx.fillStyle = "#ffffff";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.font = `${isFocus ? "bold " : ""}${Math.max(10, Math.min(14, r * 0.42))}px system-ui, -apple-system, sans-serif`;
      ctx.fillText(numFmt(n.senders), n.x, n.y);

      if (r > 22 || isFocus || isConnected) {
        ctx.fillStyle = dim ? "rgba(113,113,122,0.3)" : "rgba(161,161,170,0.8)";
        ctx.font = `${Math.max(8, Math.min(11, r * 0.28))}px system-ui, -apple-system, sans-serif`;
        const label = cleanGroupName(n.name);
        ctx.fillText(label.length > 18 ? label.slice(0, 16) + "…" : label, n.x, n.y + r + 12);
      }
      ctx.globalAlpha = 1;
    }

    ctx.restore();
  };

  /* ── Setup: simulation + canvas + interactions ──────────────────────── */

  useEffect(() => {
    if (!canvasRef.current || !containerRef.current || nodes.length === 0) return;

    const canvas = canvasRef.current;
    const container = containerRef.current;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let running = true;
    let cleanupFn: (() => void) | undefined;

    const resize = () => {
      const rect = container.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();

    const drawNow = () => {
      if (drawRef.current) drawRef.current(canvas, ctx);
    };

    (async () => {
      const d3Force = await import("d3-force");
      const d3Zoom = await import("d3-zoom");
      const d3Selection = await import("d3-selection");
      const d3Drag = await import("d3-drag");

      if (!running) return;

      const w = container.getBoundingClientRect().width;
      const h = container.getBoundingClientRect().height;
      const maxSenders = Math.max(1, ...nodes.map((n) => n.senders));

      const sim = d3Force
        .forceSimulation(nodes as any)
        .force(
          "link",
          d3Force
            .forceLink(edges as any)
            .id((d: any) => d.jid)
            .distance(120)
            .strength((e: any) => Math.max(0.1, e.overlapPct / 200)),
        )
        .force("charge", d3Force.forceManyBody().strength(-300).distanceMax(500))
        .force("center", d3Force.forceCenter(w / 2, h / 2))
        .force(
          "collision",
          d3Force.forceCollide().radius((d: any) => nodeRadius(d.senders, maxSenders) + 12),
        )
        // Settle quickly and stop so the layout doesn't keep jittering.
        .velocityDecay(0.5)
        .alphaDecay(0.08)
        .alphaMin(0.005)
        .on("tick", drawNow);

      const zoomBehavior = d3Zoom
        .zoom()
        .scaleExtent([0.2, 5])
        .on("zoom", (event) => {
          transformRef.current = event.transform;
          drawNow();
        });

      const sel = d3Selection.select(canvas);
      sel.call(zoomBehavior as any);

      const dragBehavior = d3Drag
        .drag()
        .on("start", (event: any) => {
          const node = event.subject;
          node.fx = node.x;
          node.fy = node.y;
          sim.alphaTarget(0.3).restart();
        })
        .on("drag", (event: any) => {
          const t = transformRef.current;
          const node = event.subject;
          node.fx = (event.sourceEvent.offsetX - t.x) / t.k;
          node.fy = (event.sourceEvent.offsetY - t.y) / t.k;
        })
        .on("end", (event: any) => {
          const node = event.subject;
          node.fx = null;
          node.fy = null;
          sim.alphaTarget(0);
        });

      sel.call(dragBehavior as any);

      const getNodeAt = (mx: number, my: number): SimNode | null => {
        const t = transformRef.current;
        const x = (mx - t.x) / t.k;
        const y = (my - t.y) / t.k;
        for (let i = nodes.length - 1; i >= 0; i--) {
          const n = nodes[i];
          const r = nodeRadius(n.senders, maxSenders);
          const dx = n.x - x;
          const dy = n.y - y;
          if (dx * dx + dy * dy <= r * r) return n;
        }
        return null;
      };

      const handleMove = (e: MouseEvent) => {
        const rect = canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const node = getNodeAt(mx, my);
        if (node) {
          canvas.style.cursor = "pointer";
          const connCount = connectionsMap.get(node.jid)?.size ?? 0;
          setTooltip({ x: e.clientX, y: e.clientY, node, connected: connCount });
          hoveredRef.current = node.jid;
          drawNow();
        } else {
          canvas.style.cursor = "grab";
          setTooltip(null);
          hoveredRef.current = null;
          drawNow();
        }
      };

      const handleClick = (e: MouseEvent) => {
        const rect = canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const node = getNodeAt(mx, my);
        const current = selectedRef.current;
        setSelected(node ? (node.jid === current ? null : node.jid) : null);
        rerender();
      };

      canvas.addEventListener("mousemove", handleMove);
      canvas.addEventListener("click", handleClick);

      drawNow();

      const ro = new ResizeObserver(() => {
        resize();
        drawNow();
      });
      ro.observe(container);

      cleanupFn = () => {
        canvas.removeEventListener("mousemove", handleMove);
        canvas.removeEventListener("click", handleClick);
        ro.disconnect();
        sim.stop();
      };
    })();

    return () => {
      running = false;
      cleanupFn?.();
    };
  }, [nodes, edges, connectionsMap, localityColorMap, setSelected, rerender]);

  /* ── JSX ───────────────────────────────────────────────────────────── */

  return (
    <div className="relative w-full">
      {/* Stats header row */}
      <div className="mb-4 grid grid-cols-3 gap-px border border-white/10 bg-white/10 text-center">
        {([
          ["Unique reach", uniqueMembers],
          ["Shared pairs", pairs.length],
          ["High redundancy", redundantCount],
        ] as [string, number][]).map(([label, value]) => (
          <div key={label} className="bg-[#090909] px-4 py-3">
            <div className="text-lg font-semibold tabular-nums">{numFmt(value)}</div>
            <div className="text-[10px] text-zinc-500">{label}</div>
          </div>
        ))}
      </div>

      {/* Header */}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Where your reach overlaps</h2>
          <p className="mt-0.5 text-xs text-zinc-500">
            Size = participants. Lines = shared members. Color = locality.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="hidden flex-wrap gap-x-3 gap-y-1 text-[10px] text-zinc-400 lg:flex">
            {[...localityColorMap.entries()].slice(0, 6).map(([name, color]) => (
              <span key={name} className="flex items-center gap-1">
                <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: color }} />
                {name}
              </span>
            ))}
            {localityColorMap.size > 6 && <span className="text-zinc-600">+{localityColorMap.size - 6}</span>}
          </div>
          {groups.length > 20 && (
            <button
              type="button"
              onClick={() => setShowAll((v) => !v)}
              className="shrink-0 rounded-md border border-white/10 bg-zinc-900 px-3 py-1.5 text-[11px] font-medium text-zinc-300 hover:bg-zinc-800 transition"
            >
              {showAll ? "Top 20" : `All ${groups.length}`}
            </button>
          )}
        </div>
      </div>

      {/* Canvas */}
      <div
        ref={containerRef}
        className="relative w-full overflow-hidden rounded-xl border border-white/10 bg-[radial-gradient(circle_at_center,rgba(255,255,255,0.03),transparent_65%)]"
        style={{ height: 520 }}
      >
        <canvas ref={canvasRef} className="absolute inset-0" />
        {nodes.length === 0 && (
          <div className="absolute inset-0 grid place-items-center text-xs text-zinc-600">
            Network appears after group messages are captured.
          </div>
        )}
      </div>

      {/* Tooltip */}
      {tooltip && (
        <div
          className="pointer-events-none fixed z-50 w-56 rounded-lg border border-white/15 bg-zinc-900 p-3 text-[11px] text-zinc-300 shadow-2xl"
          style={{ left: tooltip.x + 12, top: tooltip.y - 10 }}
        >
          <div className="truncate font-semibold text-white">{cleanGroupName(tooltip.node.name)}</div>
          <div className="mt-1 text-zinc-400">{numFmt(tooltip.node.senders)} participants</div>
          {tooltip.node.locality && (
            <div className="mt-0.5 text-zinc-500">
              <span className="mr-1 inline-block h-2 w-2 rounded-full" style={{ backgroundColor: nodeColor(tooltip.node, localityColorMap) }} />
              {tooltip.node.locality}
            </div>
          )}
          <div className="mt-1 text-zinc-500">
            {tooltip.connected > 0 ? `${tooltip.connected} overlapping group${tooltip.connected === 1 ? "" : "s"}` : "No overlaps"}
          </div>
        </div>
      )}

      {/* Detail panel */}
      {selectedNode && (
        <div className="mt-4 rounded-xl border border-white/10 bg-zinc-950 p-5">
          <div className="flex items-start justify-between">
            <div>
              <div className="flex items-center gap-2">
                <span className="h-3 w-3 rounded-full" style={{ backgroundColor: nodeColor(selectedNode, localityColorMap) }} />
                <h3 className="text-sm font-semibold text-white">{cleanGroupName(selectedNode.name)}</h3>
              </div>
              <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-zinc-400">
                <span>{numFmt(selectedNode.senders)} participants</span>
                {selectedNode.locality && <span>Locality: {selectedNode.locality}</span>}
                <span>{overlappingPairs.length} overlapping pairs</span>
              </div>
            </div>
            <Link
              href={`/audit/groups/${encodeURIComponent(selectedNode.jid)}`}
              className="flex items-center gap-1 rounded-md border border-white/10 px-2.5 py-1.5 text-[10px] font-medium text-zinc-300 transition hover:bg-white/[0.05]"
            >
              View group <ArrowUpRight className="h-3 w-3" />
            </Link>
          </div>
          {overlappingPairs.length > 0 && (
            <div className="mt-3 border-t border-white/[0.06] pt-3">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-600">Top overlaps</div>
              <div className="mt-2 space-y-1.5">
                {overlappingPairs.map((p) => {
                  const other = p.group_a.jid === selected ? p.group_b : p.group_a;
                  return (
                    <div key={`${p.group_a.jid}-${p.group_b.jid}`} className="flex items-center justify-between text-[11px]">
                      <span className="truncate text-zinc-300">{cleanGroupName(other.name)}</span>
                      <span className="ml-2 shrink-0 text-zinc-500">
                        {numFmt(p.shared_senders)} shared · {p.overlap_pct}%
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
