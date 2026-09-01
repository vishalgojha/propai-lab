import { Skeleton } from "@/components/ui/skeleton";

export function MetricSkeleton({ className = "" }: { className?: string }) {
  return <Skeleton aria-label="Loading metric" className={`h-8 w-20 ${className}`} />;
}

export function ListSkeleton({ rows = 3, className = "" }: { rows?: number; className?: string }) {
  return <div aria-label="Loading results" aria-busy="true" className={`space-y-3 ${className}`}>{Array.from({ length: rows }, (_, index) => <div key={index} className="rounded-xl border border-white/10 bg-zinc-900 p-4"><Skeleton className="h-4 w-2/5" /><Skeleton className="mt-3 h-3 w-3/5" /><Skeleton className="mt-2 h-3 w-1/3" /></div>)}</div>;
}

export function TableSkeleton({ rows = 6, columns = 4, className = "" }: { rows?: number; columns?: number; className?: string }) {
  return <div aria-label="Loading table" aria-busy="true" className={`space-y-2 ${className}`}>{Array.from({ length: rows }, (_, row) => <div key={row} className="flex gap-3 rounded-md border border-white/5 px-4 py-3">{Array.from({ length: columns }, (_, column) => <Skeleton key={column} className={`h-4 ${column === 0 ? "w-2/5" : "w-1/5"}`} />)}</div>)}</div>;
}
