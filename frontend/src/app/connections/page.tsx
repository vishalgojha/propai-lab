"use client";

export const dynamic = 'force-dynamic';

import { useCallback, useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { useRouter } from "next/navigation";
import { Activity, Building, Clock, Database, ImageUp, Inbox, List, LogOut, MessageSquare, RefreshCw, Shield, Smartphone, AlertTriangle, Users, Zap, Lock } from "lucide-react";
import { useAuth } from "@/lib/AuthProvider";

type ConnectionPhase =
  | "loading"
  | "qr_ready"
  | "qr_scanned"
  | "authenticating"
  | "connected"
  | "syncing"
  | "reconnecting"
  | "error";

function randomMovieQuote() {
  return MOVIE_QUOTES[Math.floor(Math.random() * MOVIE_QUOTES.length)];
}

const MOVIE_QUOTES = [
  "Life finds a way. — Jurassic Park",
  "I'll be back. — Terminator 2",
  "Why so serious? — The Dark Knight",
  "There's no place like home. — The Wizard of Oz",
  "To infinity and beyond! — Toy Story",
  "You shall not pass! — The Lord of the Rings",
  "I'm the king of the world! — Titanic",
  "Just keep swimming. — Finding Nemo",
  "Hakuna Matata. — The Lion King",
  "I feel the need — the need for speed! — Top Gun",
  "You can't handle the truth! — A Few Good Men",
  "The name's Bond. James Bond. — Casino Royale",
  "May the Force be with you. — Star Wars",
  "I see dead people. — The Sixth Sense",
  "Here's looking at you, kid. — Casablanca",
  "I'm gonna make him an offer he can't refuse. — The Godfather",
  "You're gonna need a bigger boat. — Jaws",
  "I have a bad feeling about this. — Star Wars",
  "It's alive! It's alive! — Frankenstein",
  "They live. — They Live",
  "I'll have what she's having. — When Harry Met Sally",
  "Keep your friends close, but your enemies closer. — The Godfather Part II",
  "Snakes. Why'd it have to be snakes? — Raiders of the Lost Ark",
  "Roads? Where we're going we don't need roads. — Back to the Future",
  "Show me the money! — Jerry Maguire",
  "You're killing me, Smalls. — The Sandlot",
  "Forget it, Jake. It's Chinatown. — Chinatown",
  "You had me at hello. — Jerry Maguire",
  "Nobody puts Baby in a corner. — Dirty Dancing",
  "I'll get you, my pretty, and your little dog too! — The Wizard of Oz",
  "Carpe diem. Seize the day, boys. — Dead Poets Society",
  "E.T. phone home. — E.T.",
  "Houston, we have a problem. — Apollo 13",
  "Go ahead, make my day. — Sudden Impact",
  "I'm walking here! — Midnight Cowboy",
  "Hello, my name is Inigo Montoya. You killed my father. Prepare to die. — The Princess Bride",
  "My precious. — The Lord of the Rings",
  "I am your father. — Star Wars",
  "Get your paws off me, you damned dirty ape! — Planet of the Apes",
  "Magic Mirror on the wall, who is the fairest one of all? — Snow White",
  "I think this is the beginning of a beautiful friendship. — Casablanca",
  "Of all the gin joints in all the towns in all the world, she walks into mine. — Casablanca",
  "Round up the usual suspects. — Casablanca",
  "Play it, Sam. Play 'As Time Goes By.' — Casablanca",
  "Frankly, my dear, I don't give a damn. — Gone with the Wind",
  "After all, tomorrow is another day. — Gone with the Wind",
  "There's no crying in baseball! — A League of Their Own",
  "I love the smell of napalm in the morning. — Apocalypse Now",
  "I'm mad as hell, and I'm not going to take this anymore! — Network",
  "You talkin' to me? — Taxi Driver",
  "I could dance with you till the cows come home. — The Princess Bride",
  "As you wish. — The Princess Bride",
  "You keep using that word. I do not think it means what you think it means. — The Princess Bride",
  "Have fun storming the castle! — The Princess Bride",
  "I'm not left-handed either. — The Princess Bride",
  "Hello. My name is Inigo Montoya. — The Princess Bride",
  "I'll tell you in a word... inconceivable! — The Princess Bride",
  "Never go in against a Sicilian when death is on the line! — The Princess Bride",
  "Are you not entertained?! — Gladiator",
  "This is Sparta! — 300",
  "I'm the one who knocks. — Breaking Bad",
  "I am the danger. — Breaking Bad",
  "Say my name. — Breaking Bad",
  "I am the one who knocks. — Breaking Bad",
  "I'm not in danger, Skyler. I AM the danger. — Breaking Bad",
  "I'm the one who knocks! — Breaking Bad",
  "I've seen things you people wouldn't believe. — Blade Runner",
  "Tears in rain. Time to die. — Blade Runner",
  "I've seen things you people wouldn't believe. Attack ships on fire off the shoulder of Orion. I watched C-beams glitter in the dark near the Tannhäuser Gate. — Blade Runner",
  "This is the way. — The Mandalorian",
];

const DISCONNECT_REASONS: Record<string, string> = {
  "408": "QR expired — tap to refresh",
  "429": "Too many attempts, please wait",
  "401": "Session expired, please re-link",
  "500": "Connection lost — unexpected error",
  "logged_out": "WhatsApp logged out",
  "closed": "Connection closed",
};

type HealthStatus = "healthy" | "warning" | "error";

function StatusDot({ status }: { status: HealthStatus }) {
  const colors = { healthy: "bg-emerald-400", warning: "bg-amber-400", error: "bg-red-400" };
  return <span className={`w-2 h-2 rounded-full ${colors[status]} shrink-0`} />;
}

function StatBox({ icon, label, value, status }: { icon: React.ReactNode; label: string; value: string; status?: HealthStatus }) {
  return (
    <div className="flex items-center gap-3 p-4">
      <div className="flex h-10 w-10 items-center justify-center shrink-0">
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[11px] font-medium text-zinc-500 uppercase tracking-wider">{label}</div>
        <div className="mt-0.5 flex items-center gap-2">
          <span className="text-sm font-bold text-white truncate">{value}</span>
          {status && <StatusDot status={status} />}
        </div>
      </div>
    </div>
  );
}

function HealthRow({ label, status, detail }: { label: string; status: HealthStatus; detail: string }) {
  const labels = { healthy: "Healthy", warning: "Warning", error: "Error" };
  const colors = { healthy: "text-emerald-400", warning: "text-amber-400", error: "text-red-400" };
  return (
    <div className="flex items-center justify-between py-2.5 border-b border-white/[0.04] last:border-0">
      <span className="text-xs text-zinc-400">{label}</span>
      <div className="flex items-center gap-2">
        <span className="text-xs text-zinc-500">{detail}</span>
        <span className={`text-[11px] font-semibold ${colors[status]}`}>{labels[status]}</span>
        <StatusDot status={status} />
      </div>
    </div>
  );
}

function ActivityItem({ icon, text, time }: { icon: React.ReactNode; text: string; time: string }) {
  return (
    <div className="flex items-start gap-3 py-2">
      <div className="mt-0.5 flex h-6 w-6 items-center justify-center">{icon}</div>
      <div className="flex-1 min-w-0">
        <div className="text-xs text-zinc-300">{text}</div>
        <div className="text-[11px] text-zinc-600">{time}</div>
      </div>
    </div>
  );
}

function QRDisplay({ qrText, onRefresh, refreshing }: { qrText: string; onRefresh: () => void; refreshing: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!canvasRef.current) return;
    QRCode.toCanvas(canvasRef.current, qrText, {
      width: 360,
      margin: 2,
      color: { dark: "#000000", light: "#ffffff" },
    });
  }, [qrText]);

  return (
    <div className="flex flex-col items-center">
      <canvas
        ref={canvasRef}
        className="rounded-xl border-[6px] border-white bg-white"
        style={{ width: "min(360px, 100%)", height: "min(360px, 100%)", aspectRatio: "1/1" }}
      />
      <button
        onClick={onRefresh}
        disabled={refreshing}
        className="mt-3 rounded-lg bg-[#3EE88A] px-4 py-2.5 text-xs font-bold text-black min-h-[44px] disabled:opacity-50 w-full max-w-[360px]"
      >
        {refreshing ? "Refreshing..." : "Refresh QR"}
      </button>
    </div>
  );
}

function LoadingDots() {
  const [dots, setDots] = useState("");
  useEffect(() => {
    const interval = setInterval(() => setDots((d) => (d.length >= 3 ? "" : d + ".")), 500);
    return () => clearInterval(interval);
  }, []);
  return <span>{dots}</span>;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-white/10 overflow-hidden">
      <div className="px-5 py-3 border-b border-white/10">
        <h3 className="text-sm font-bold text-white">{title}</h3>
      </div>
      <div className="px-5 py-3">{children}</div>
    </div>
  );
}

function ActionButton({ icon, label, onClick, variant }: { icon: React.ReactNode; label: string; onClick: () => void; variant?: "primary" | "danger" | "default" }) {
  const styles = {
    primary: "bg-[#3EE88A] text-black hover:bg-[#3EE88A]/90",
    danger: "border border-red-500/30 bg-red-500/10 text-red-300 hover:bg-red-500/20",
    default: "border border-white/10 bg-zinc-800 text-zinc-300 hover:bg-zinc-700",
  };
  return (
    <button
      onClick={onClick}
      className={`flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-xs font-bold min-h-[44px] transition-colors ${styles[variant || "default"]}`}
    >
      {icon}
      {label}
    </button>
  );
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

function formatTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const now = Date.now();
  const diff = now - d.getTime();
  if (diff < 60000) return "Just now";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return d.toLocaleDateString();
}

export default function ConnectionCenterPage() {
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();

  // Redirect to login if not authenticated
  useEffect(() => {
    if (!authLoading && !user) {
      router.push("/auth/login?next=/connections");
    }
  }, [user, authLoading, router]);

  const [phase, setPhase] = useState<ConnectionPhase>("loading");
  const [qrText, setQrText] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [phoneNumber, setPhoneNumber] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState<string | null>(null);
  const [groups, setGroups] = useState<number | null>(null);
  const [messages, setMessages] = useState<number | null>(null);
  const [lastSync, setLastSync] = useState<string | null>(null);
  const [connectedSince, setConnectedSince] = useState<string | null>(null);
  const [lastMessageAt, setLastMessageAt] = useState<string | null>(null);
  const [totalParsed, setTotalParsed] = useState<number>(0);
  const [totalListings, setTotalListings] = useState<number>(0);
  const [totalRequirements, setTotalRequirements] = useState<number>(0);
  const [totalBrokers, setTotalBrokers] = useState<number>(0);
  const [totalBuildings, setTotalBuildings] = useState<number>(0);
  const [qrLoading, setQrLoading] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);
  const wasEverConnectedRef = useRef(false);
  const reconnectAttempts = useRef(0);

  const fetchStats = useCallback(async () => {
    try {
      const [detail, stats] = await Promise.all([
        fetch("/api/sync/connection").then((r) => r.json()),
        fetch("/api/stats").then((r) => r.json()).catch(() => ({})),
      ]);
      if (detail?.phone_number) setPhoneNumber(detail.phone_number);
      if (detail?.display_name) setDisplayName(detail.display_name);
      if (detail?.total_groups != null) setGroups(detail.total_groups);
      if (detail?.messages_found != null) setMessages(detail.messages_found);
      if (detail?.last_sync) setLastSync(detail.last_sync);
      if (detail?.connected_since) setConnectedSince(detail.connected_since);
      if (detail?.last_message_at) setLastMessageAt(detail.last_message_at);

      // Bootstrap phase from the polling endpoint (reliable even if SSE is flaky)
      if (detail?.connected || detail?.connection_state === "open") {
        setPhase((p) => (p === "connected" || p === "syncing" ? p : "connected"));
        wasEverConnectedRef.current = true;
        reconnectAttempts.current = 0;
      }

      if (stats?.total_messages != null && !detail?.messages_found) setMessages(stats.total_messages);
      if (stats?.total_parsed != null) setTotalParsed(stats.total_parsed);
      if (stats?.total_listings != null) setTotalListings(stats.total_listings);
      if (stats?.total_requirements != null) setTotalRequirements(stats.total_requirements);
      if (stats?.total_brokers != null) setTotalBrokers(stats.total_brokers);
      if (stats?.total_buildings != null) setTotalBuildings(stats.total_buildings);
    } catch { /* ignore */ }
  }, []);

  const handleConnected = useCallback((data: Record<string, unknown>) => {
    setPhase("connected");
    wasEverConnectedRef.current = true;
    reconnectAttempts.current = 0;
    setPhoneNumber((data.phone_number as string) || null);
    setDisplayName((data.display_name as string) || null);
    fetchStats();
  }, [fetchStats]);

  const handleDisconnected = useCallback((data: Record<string, unknown>) => {
    const reason = (data.reason as string) || "unknown";
    const specific = DISCONNECT_REASONS[String(reason)];
    setPhase("error");
    setErrorMsg(specific || randomMovieQuote());
    setQrText(null);
  }, []);

  const loadingFallback = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (phase !== "loading") return;
    loadingFallback.current = setTimeout(() => {
      setPhase("error");
      setErrorMsg(randomMovieQuote());
    }, 8000);
    return () => { if (loadingFallback.current) clearTimeout(loadingFallback.current); };
  }, [phase]);

  const connectSSE = useCallback(() => {
    if (eventSourceRef.current) eventSourceRef.current.close();

    const es = new EventSource("/api/sync/events");
    eventSourceRef.current = es;

    // ── Heartbeat: SSE is alive, nothing to do ──
    es.addEventListener("heartbeat", () => {
      // If reconnecting and we get a heartbeat, the transport is back
      setPhase((p) => {
        if (p === "reconnecting") return "reconnecting"; // stay waiting for real state
        return p;
      });
    });

    // ── Status: periodic full state snapshot ──
    es.addEventListener("status", (e) => {
      try {
        const data = JSON.parse(e.data);
        const cs = data.connection_state || "";

        if (cs === "open" && data.connected) {
          handleConnected(data as Record<string, unknown>);
        } else if (cs === "qr" && data.qr) {
          setQrText(data.qr as string);
          setPhase("qr_ready");
          setErrorMsg(null);
        } else if (cs === "closed" || cs === "logged_out") {
          handleDisconnected({ reason: cs, ...data } as Record<string, unknown>);
        } else if (cs === "error") {
          setPhase("error");
          setErrorMsg((data.error as string) || randomMovieQuote());
        } else if (cs === "unknown" || !cs) {
          // Only show movie quote on initial load; if we were connected, stay reconnecting
          if (!wasEverConnectedRef.current) {
            setPhase("error");
            setErrorMsg(randomMovieQuote());
          }
        }
      } catch { /* ignore */ }
    });

    es.addEventListener("connected", (e) => {
      try {
        const data = JSON.parse(e.data);
        handleConnected(data as Record<string, unknown>);
      } catch { /* ignore */ }
    });

    es.addEventListener("qr_ready", (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.qr) {
          setQrText(data.qr);
          setPhase("qr_ready");
          setErrorMsg(null);
        }
      } catch { /* ignore */ }
    });

    es.addEventListener("qr_scanned", () => {
      setPhase("qr_scanned");
      setQrText(null);
      setTimeout(() => setPhase("authenticating"), 600);
    });

    es.addEventListener("disconnected", (e) => {
      try {
        const data = JSON.parse(e.data);
        handleDisconnected(data as Record<string, unknown>);
      } catch { /* ignore */ }
    });

    es.onerror = () => {
      es.close();
      if (wasEverConnectedRef.current) {
        setPhase("reconnecting");
        setErrorMsg(null);
      }
      // Exponential backoff: 2s, 4s, 8s, 16s, max 30s
      reconnectAttempts.current += 1;
      const delay = Math.min(2000 * Math.pow(2, reconnectAttempts.current - 1), 30000);
      setTimeout(connectSSE, delay);
    };
  }, [handleConnected, handleDisconnected]);

  useEffect(() => {
    if (authLoading || !user) return;
    connectSSE();
    fetchStats(); // Bootstrap phase from polling endpoint (reliable even if SSE is flaky)
    return () => {
      if (eventSourceRef.current) eventSourceRef.current.close();
    };
  }, [authLoading, user, connectSSE, fetchStats]);

  useEffect(() => {
    if (authLoading || !user) return;
    if (phase === "connected" || phase === "syncing") fetchStats();
  }, [authLoading, user, phase, fetchStats]);

  const fetchQR = useCallback(async () => {
    setQrLoading(true);
    setErrorMsg(null);
    try {
      const res = await fetch("/api/sync/qr").then((r) => r.json());
      if (res?.qr) {
        setQrText(res.qr);
        setPhase("qr_ready");
      } else {
        setErrorMsg(res?.message || "No QR available");
      }
    } catch {
      setErrorMsg("Could not fetch QR code");
    } finally {
      setQrLoading(false);
    }
  }, []);

  const handleDisconnect = useCallback(async () => {
    setDisconnecting(true);
    try {
      await fetch("/api/sync/logout", { method: "POST" });
      setPhase("error");
      setErrorMsg("Disconnected. You can reconnect below.");
      setPhoneNumber(null);
      setDisplayName(null);
      setGroups(null);
      setMessages(null);
      setLastSync(null);
      setConnectedSince(null);
      setLastMessageAt(null);
    } catch {
      setErrorMsg("Failed to disconnect");
    } finally {
      setDisconnecting(false);
    }
  }, []);

  const connectionHealth: HealthStatus = phase === "connected" || phase === "syncing" ? "healthy" : phase === "reconnecting" ? "warning" : "error";
  const dbHealth: HealthStatus = totalParsed > 0 ? "healthy" : "warning";
  const aiHealth: HealthStatus = totalListings > 0 ? "healthy" : "warning";
  const realtimeHealth: HealthStatus = phase === "connected" ? "healthy" : phase === "reconnecting" ? "warning" : "error";

  const isConnected = phase === "connected" || phase === "syncing";
  const connectedSeconds = connectedSince ? Math.floor((Date.now() - new Date(connectedSince).getTime()) / 1000) : 0;

  const displayPhone = phoneNumber || "WhatsApp Connected";
  const formatPhone = (p: string) => {
    if (p.startsWith("+")) return p;
    const digits = p.replace(/\D/g, "");
    if (digits.length === 12) return `+${digits.slice(0, 2)} ${digits.slice(2)}`;
    if (digits.length === 10) return `+91 ${digits}`;
    return `+${digits}`;
  };

  if (authLoading || !user) {
    return null;
  }

  return (
    <div className="max-w-6xl mx-auto px-4 lg:px-6 pt-12 pb-12">
      <div className="mb-8">
        <h2 className="text-lg font-bold text-white">WhatsApp Connection</h2>
        <p className="mt-2 max-w-2xl text-sm text-zinc-500">
          Monitor and manage your WhatsApp integration. All data is processed in real-time.
        </p>
      </div>

      {!isConnected ? (
        <>
          {/* ── Not Connected / QR / Error ── */}
          <div className="rounded-2xl border border-white/10 bg-zinc-900 p-5">
            {phase === "loading" && (
              <div className="flex items-center justify-center py-16 text-sm text-zinc-500">Loading...</div>
            )}

            {phase === "qr_ready" && qrText && (
              <div className="flex flex-col lg:flex-row items-start gap-6">
                <div className="flex-shrink-0 w-full max-w-[360px] mx-auto lg:mx-0">
                  <QRDisplay qrText={qrText} onRefresh={fetchQR} refreshing={qrLoading} />
                </div>
                <div className="flex-1 min-w-0">
                  <h4 className="text-sm font-bold text-white mb-3">How to connect</h4>
                  <ol className="space-y-3 text-base text-zinc-400">
                    <li className="flex items-start gap-2">
                      <span className="flex-shrink-0 w-6 h-6 rounded-full bg-[#3EE88A]/10 text-[#3EE88A] flex items-center justify-center text-xs font-bold">1</span>
                      <span>Open <strong className="text-white">WhatsApp</strong> on your phone</span>
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="flex-shrink-0 w-6 h-6 rounded-full bg-[#3EE88A]/10 text-[#3EE88A] flex items-center justify-center text-xs font-bold">2</span>
                      <span>Go to <strong className="text-white">Settings</strong> → <strong className="text-white">Linked Devices</strong></span>
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="flex-shrink-0 w-6 h-6 rounded-full bg-[#3EE88A]/10 text-[#3EE88A] flex items-center justify-center text-xs font-bold">3</span>
                      <span>Tap <strong className="text-white">Link a Device</strong></span>
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="flex-shrink-0 w-6 h-6 rounded-full bg-[#3EE88A]/10 text-[#3EE88A] flex items-center justify-center text-xs font-bold">4</span>
                      <span>Scan this QR code with your phone</span>
                    </li>
                  </ol>
                  <p className="mt-4 text-xs text-zinc-600">QR refreshes automatically if expired.</p>
                </div>
              </div>
            )}

            {(phase === "qr_scanned" || phase === "authenticating") && (
              <div className="flex flex-col items-center py-12 text-center">
                <div className="w-10 h-10 rounded-full border-2 border-zinc-600 border-t-[#3EE88A] animate-spin" />
                <div className="mt-4 text-sm font-semibold text-white">Pairing with WhatsApp<LoadingDots /></div>
                <div className="mt-1 text-xs text-zinc-500">Finishing secure connection<LoadingDots /></div>
              </div>
            )}

            {phase === "reconnecting" && (
              <div className="flex flex-col items-center py-12 text-center">
                <div className="w-10 h-10 rounded-full border-2 border-zinc-600 border-t-amber-400 animate-spin" />
                <div className="mt-4 text-sm font-semibold text-amber-400">Reconnecting<LoadingDots /></div>
                <div className="mt-1 text-xs text-zinc-500">Trying to restore your WhatsApp session</div>
              </div>
            )}

            {phase === "error" && (
              <div className="flex flex-col items-center py-12 text-center">
                <div className="w-10 h-10 rounded-full bg-zinc-800 flex items-center justify-center mb-3">
                  <MessageSquare className="w-5 h-5 text-zinc-400" strokeWidth={1.5} />
                </div>
                <p className="text-sm text-zinc-300 italic max-w-md leading-relaxed">"{errorMsg || "Something went wrong"}"</p>
                <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
                  <button
                    onClick={fetchQR}
                    disabled={qrLoading}
                    className="rounded-lg bg-[#3EE88A] px-6 py-2.5 text-xs font-bold text-black min-h-[44px] disabled:opacity-50"
                  >
                    {qrLoading ? "Loading..." : "Scan QR Code"}
                  </button>
                  <button
                    onClick={async () => {
                      setQrLoading(true);
                      try {
                        await fetch("/api/sync/refresh-qr", { method: "POST" });
                        await fetchQR();
                      } catch {
                        setErrorMsg("Could not refresh QR");
                      } finally {
                        setQrLoading(false);
                      }
                    }}
                    disabled={qrLoading}
                    className="rounded-lg border border-white/20 px-6 py-2.5 text-xs font-bold text-white min-h-[44px] disabled:opacity-50"
                  >
                    Force Fresh QR
                  </button>
                </div>
              </div>
            )}
          </div>
        </>
      ) : (
        /* ── Connected Dashboard ── */
        <div className="space-y-6">

          {/* ═══ Connection ═══ */}
          <Section title="Connection">
            <div className="flex items-center gap-4 mb-4">
              <div className="flex h-14 w-14 items-center justify-center rounded-full bg-[#3EE88A]/10">
                <Smartphone className="w-6 h-6 text-[#3EE88A]" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-base font-bold text-white">{formatPhone(displayPhone)}</span>
                  <StatusDot status="healthy" />
                </div>
                {displayName && <div className="text-xs text-zinc-500">{displayName}</div>}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-0 [&>*:nth-child(2n)]:border-l [&>*:nth-child(2n)]:border-white/10 [&>*:nth-child(n+3)]:border-t [&>*:nth-child(n+3)]:border-white/10">
              <StatBox icon={<Clock className="w-4 h-4 text-zinc-400" />} label="Connected" value={connectedSeconds ? formatDuration(connectedSeconds) : "—"} />
              <StatBox icon={<Activity className="w-4 h-4 text-zinc-400" />} label="Last Activity" value={formatTime(lastMessageAt || lastSync)} />
              <StatBox icon={<Users className="w-4 h-4 text-zinc-400" />} label="Connected Account" value={displayName || "—"} />
              <StatBox icon={<Shield className="w-4 h-4 text-zinc-400" />} label="Status" value={connectionHealth === "healthy" ? "Healthy" : "Offline"} status={connectionHealth} />
            </div>
          </Section>

          {/* ═══ Activity ═══ */}
          <Section title="Activity">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-0 [&>*:nth-child(2n)]:sm:border-l [&>*:nth-child(2n)]:border-white/10 [&>*:nth-child(n+3)]:border-t [&>*:nth-child(n+3)]:border-white/10">
              <StatBox icon={<MessageSquare className="w-4 h-4 text-zinc-400" />} label="Total Messages" value={messages?.toLocaleString() || "—"} />
              <StatBox icon={<Zap className="w-4 h-4 text-zinc-400" />} label="AI Processed" value={totalParsed?.toLocaleString() || "—"} />
              <StatBox icon={<List className="w-4 h-4 text-zinc-400" />} label="Items Extracted" value={(totalListings + totalRequirements)?.toLocaleString() || "—"} />
              <StatBox icon={<Users className="w-4 h-4 text-zinc-400" />} label="Brokers Identified" value={totalBrokers?.toLocaleString() || "—"} />
            </div>
          </Section>

          {/* ═══ Coverage ═══ */}
          <Section title="Coverage">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-0 [&>*:nth-child(2n)]:sm:border-l [&>*:nth-child(2n)]:border-white/10 [&>*:nth-child(n+3)]:border-t [&>*:nth-child(n+3)]:border-white/10">
              <StatBox icon={<Users className="w-4 h-4 text-zinc-400" />} label="Groups" value={groups?.toLocaleString() || "—"} />
              <StatBox icon={<MessageSquare className="w-4 h-4 text-zinc-400" />} label="Private Chats" value="—" />
              <StatBox icon={<Activity className="w-4 h-4 text-zinc-400" />} label="Active Conversations" value="—" />
              <StatBox icon={<Building className="w-4 h-4 text-zinc-400" />} label="Buildings Tracked" value={totalBuildings?.toLocaleString() || "—"} />
            </div>
          </Section>

          {/* ═══ System Health ═══ */}
          <Section title="System Health">
            <div>
              <HealthRow label="WhatsApp Connection" status={connectionHealth} detail={`${displayPhone} (${displayName || "—"})`} />
              <HealthRow label="Database" status={dbHealth} detail={`${messages?.toLocaleString() || "0"} messages stored`} />
              <HealthRow label="AI Processing" status={aiHealth} detail={`${totalParsed?.toLocaleString() || "0"} messages processed`} />
              <HealthRow label="Real-time Updates" status={realtimeHealth} detail={phase === "connected" ? "Active" : "Disconnected"} />
            </div>
          </Section>

          {/* ═══ Quick Actions ═══ */}
          <Section title="Quick Actions">
            <div className="grid grid-cols-2 gap-3">
              <ActionButton icon={<LogOut className="w-3.5 h-3.5" />} label="Disconnect" onClick={handleDisconnect} variant="danger" />
              <ActionButton icon={<RefreshCw className="w-3.5 h-3.5" />} label="Refresh" onClick={fetchStats} />
              <ActionButton icon={<ImageUp className="w-3.5 h-3.5" />} label="Re-sync" onClick={() => fetch("/api/sync/qr").catch(() => {})} />
              <ActionButton icon={<Inbox className="w-3.5 h-3.5" />} label="Open Inbox" onClick={() => router.push("/inbox")} variant="primary" />
            </div>
          </Section>

          {/* ═══ Recent Activity ═══ */}
          <Section title="Recent Activity">
            <div className="divide-y divide-white/[0.04]">
              <ActivityItem icon={<Smartphone className="w-3 h-3 text-emerald-400" />} text="WhatsApp connected successfully" time={connectedSince ? formatTime(connectedSince) : "Just now"} />
              {lastMessageAt && (
                <ActivityItem icon={<MessageSquare className="w-3 h-3 text-zinc-400" />} text="Last message received" time={formatTime(lastMessageAt)} />
              )}
              {totalParsed > 0 && (
                <ActivityItem icon={<Zap className="w-3 h-3 text-zinc-400" />} text={`AI processed ${totalParsed.toLocaleString()} messages`} time="—" />
              )}
              {(totalListings > 0 || totalRequirements > 0) && (
                <ActivityItem icon={<List className="w-3 h-3 text-zinc-400" />} text={`${(totalListings + totalRequirements).toLocaleString()} items extracted (${totalListings} listings, ${totalRequirements} requirements)`} time="—" />
              )}
              {messages && messages > 0 && (
                <ActivityItem icon={<Database className="w-3 h-3 text-zinc-400" />} text={`${messages.toLocaleString()} total messages in database`} time="—" />
              )}
            </div>
          </Section>
        </div>
      )}
    </div>
  );
}
