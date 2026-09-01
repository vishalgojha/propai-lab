"use client";

import { useMemo, useState, type ReactNode } from "react";

export type DataTableColumn<T> = {
  id: string;
  header: string;
  accessor?: (row: T) => unknown;
  cell?: (row: T) => ReactNode;
  className?: string;
  sortable?: boolean;
  hideable?: boolean;
};

type DataTableProps<T> = {
  columns: DataTableColumn<T>[];
  data: T[];
  getRowId: (row: T, index: number) => string;
  emptyMessage?: string;
  pageSize?: number;
  rowClassName?: string;
  onRowClick?: (row: T) => void;
  toolbar?: ReactNode;
  footerLabel?: string;
  tone?: "dark" | "light";
};

function sortableValue<T>(row: T, column: DataTableColumn<T>) {
  const value = column.accessor?.(row);
  if (value == null) return "";
  return typeof value === "number" ? value : String(value).toLowerCase();
}

export function DataTable<T>({ columns, data, getRowId, emptyMessage = "No records found.", pageSize = 10, rowClassName = "", onRowClick, toolbar, footerLabel, tone = "dark" }: DataTableProps<T>) {
  const [sort, setSort] = useState<{ id: string; direction: "asc" | "desc" } | null>(null);
  const [page, setPage] = useState(0);
  const [hidden, setHidden] = useState<string[]>([]);
  const visibleColumns = columns.filter((column) => !hidden.includes(column.id));
  const sorted = useMemo(() => {
    if (!sort) return data;
    const column = columns.find((item) => item.id === sort.id);
    if (!column?.sortable) return data;
    return [...data].sort((a, b) => {
      const left = sortableValue(a, column);
      const right = sortableValue(b, column);
      if (left === right) return 0;
      const result = left > right ? 1 : -1;
      return sort.direction === "asc" ? result : -result;
    });
  }, [columns, data, sort]);
  const pageCount = Math.max(1, Math.ceil(sorted.length / pageSize));
  const safePage = Math.min(page, pageCount - 1);
  const rows = sorted.slice(safePage * pageSize, (safePage + 1) * pageSize);
  const dark = tone === "dark";
  const border = dark ? "border-[var(--line)]" : "border-[rgba(22,37,43,.1)]";
  const head = dark ? "bg-[var(--ink)] text-[var(--text-secondary)]" : "bg-[#EAF3F0] text-[#49615F]";
  const text = dark ? "text-[var(--mist)]" : "text-[#16252B]";
  const muted = dark ? "text-[var(--text-secondary)]" : "text-[#49615F]";

  const toggleSort = (column: DataTableColumn<T>) => {
    if (!column.sortable) return;
    setPage(0);
    setSort((current) => current?.id === column.id
      ? { id: column.id, direction: current.direction === "asc" ? "desc" : "asc" }
      : { id: column.id, direction: "asc" });
  };

  return <div className="space-y-3">
    {toolbar && <div className={`flex flex-wrap items-center justify-between gap-3 rounded-lg border ${border} px-3 py-2`}>{toolbar}<details className="relative"><summary className={`cursor-pointer list-none text-xs ${muted}`}>Columns</summary><div className={`absolute right-0 top-7 z-20 w-48 rounded-lg border ${border} bg-white p-2 shadow-xl`}>{columns.filter((column) => column.hideable !== false).map((column) => <label key={column.id} className="flex items-center gap-2 px-2 py-1.5 text-xs text-[#16252B]"><input type="checkbox" checked={!hidden.includes(column.id)} onChange={() => setHidden((current) => current.includes(column.id) ? current.filter((id) => id !== column.id) : [...current, column.id])} />{column.header}</label>)}</div></details></div>}
    <div className={`overflow-x-auto rounded-lg border ${border}`}>
      <table className="w-full min-w-[680px] text-left text-xs">
        <thead className={`sticky top-0 ${head} text-[10px] uppercase tracking-[.12em]`}><tr>{visibleColumns.map((column) => <th key={column.id} className={`px-4 py-3 ${column.className || ""}`}><button type="button" disabled={!column.sortable} onClick={() => toggleSort(column)} className={`inline-flex items-center gap-1 font-medium ${column.sortable ? "hover:text-[#287D82]" : ""}`}>{column.header}{sort?.id === column.id && <span aria-label={sort.direction === "asc" ? "sorted ascending" : "sorted descending"}>{sort.direction === "asc" ? "↑" : "↓"}</span>}</button></th>)}</tr></thead>
        <tbody>{rows.map((row, index) => <tr key={getRowId(row, index)} onClick={() => onRowClick?.(row)} className={`border-t ${border} align-top ${onRowClick ? "cursor-pointer" : ""} ${rowClassName} ${dark ? "hover:bg-[var(--monsoon-teal)]/[0.05]" : "hover:bg-white"}`}>{visibleColumns.map((column) => <td key={column.id} className={`px-4 py-3 ${column.className || ""} ${text}`}>{column.cell ? column.cell(row) : String(column.accessor?.(row) ?? "—")}</td>)}</tr>)}</tbody>
      </table>
      {!rows.length && <p className={`px-4 py-8 text-center text-xs ${muted}`}>{emptyMessage}</p>}
    </div>
    <div className={`flex flex-wrap items-center justify-between gap-3 text-xs ${muted}`}><span>{footerLabel || `${sorted.length} records`}</span><div className="flex items-center gap-2"><button type="button" disabled={safePage === 0} onClick={() => setPage((current) => Math.max(0, current - 1))} className="rounded-md border border-current px-2 py-1 disabled:cursor-not-allowed disabled:opacity-40">Previous</button><span>Page {safePage + 1} of {pageCount}</span><button type="button" disabled={safePage >= pageCount - 1} onClick={() => setPage((current) => Math.min(pageCount - 1, current + 1))} className="rounded-md border border-current px-2 py-1 disabled:cursor-not-allowed disabled:opacity-40">Next</button></div></div>
  </div>;
}
