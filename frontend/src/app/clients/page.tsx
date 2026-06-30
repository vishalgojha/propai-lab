"use client";

import { useEffect, useMemo, useState } from "react";
import * as api from "@/lib/api";
import { Mail, Phone, Search, UserCheck } from "lucide-react";

export default function ClientsPage() {
  const [clients, setClients] = useState<api.Client[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setLoading(true);

    api.getClients(query)
      .then((data) => {
        if (active) setClients(data || []);
      })
      .catch(() => {
        if (active) setClients([]);
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [query]);

  const activeCount = useMemo(
    () => clients.filter((client) => (client.status || "active") === "active").length,
    [clients],
  );

  return (
    <div className="max-w-5xl">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-lg font-bold text-[#e2e8f0]">My Clients</h2>
          <p className="mt-1 text-sm text-[#64748b]">{activeCount} active clients in your workspace.</p>
        </div>
        <label className="flex h-10 w-full items-center gap-2 rounded-lg border border-[rgba(255,255,255,0.08)] bg-[#0d1117] px-3 sm:w-72">
          <Search className="h-4 w-4 text-[#64748b]" strokeWidth={1.5} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search clients"
            className="min-w-0 flex-1 bg-transparent text-sm text-[#e2e8f0] outline-none placeholder:text-[#4a5568]"
          />
        </label>
      </div>

      {loading ? (
        <div className="mt-6 rounded-2xl border border-[rgba(255,255,255,0.06)] bg-[#0d1117] p-8 text-center text-sm text-[#64748b]">
          Loading clients...
        </div>
      ) : clients.length === 0 ? (
        <div className="mt-6 rounded-2xl border border-[rgba(255,255,255,0.06)] bg-[#0d1117] p-8 text-center">
          <div className="text-sm font-semibold text-[#e2e8f0]">No clients found.</div>
          <div className="mx-auto mt-2 max-w-xl text-sm text-[#64748b]">
            Clients created from inbox actions and saved requirements will appear here.
          </div>
        </div>
      ) : (
        <div className="mt-6 space-y-2">
          {clients.map((client) => (
            <div
              key={client.id}
              className="rounded-xl border border-[rgba(255,255,255,0.06)] bg-[#0d1117] p-4 transition-colors hover:border-[rgba(255,255,255,0.12)]"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <UserCheck className="h-4 w-4 shrink-0 text-[#3EE88A]" strokeWidth={1.5} />
                    <div className="truncate text-sm font-semibold text-[#e2e8f0]">{client.name}</div>
                    <span className="badge badge-green text-[8px]">{client.status || "active"}</span>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[#64748b]">
                    {client.phone && (
                      <span className="flex items-center gap-1">
                        <Phone className="h-3 w-3" strokeWidth={1.5} />
                        <span className="font-mono">{client.phone}</span>
                      </span>
                    )}
                    {client.email && (
                      <span className="flex items-center gap-1">
                        <Mail className="h-3 w-3" strokeWidth={1.5} />
                        <span>{client.email}</span>
                      </span>
                    )}
                  </div>
                  {client.notes && <div className="mt-2 text-sm text-[#94a3b8]">{client.notes}</div>}
                </div>
                <div className="shrink-0 text-right text-[10px] uppercase tracking-[0.16em] text-[#475569]">
                  Client #{client.id}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
