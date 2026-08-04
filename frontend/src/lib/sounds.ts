const MUTE_KEY = "propai_sounds_muted";
const VOLUME_KEY = "propai_sounds_volume";
const EVENTS_KEY = "propai_sounds_events";

export type SoundEvent = "whatsapp" | "groups" | "connection" | "leads";
const DEFAULT_EVENTS: Record<SoundEvent, boolean> = {
  whatsapp: true,
  groups: false,
  connection: true,
  leads: true,
};

let ctx: AudioContext | null = null;

function getCtx(): AudioContext | null {
  const Ctor = typeof window !== "undefined"
    ? (window.AudioContext || (window as any).webkitAudioContext)
    : null;
  if (!Ctor) return null;
  if (!ctx) ctx = new Ctor();
  if (ctx.state === "suspended") ctx.resume();
  return ctx;
}

function muted(): boolean {
  if (typeof window === "undefined") return true;
  return localStorage.getItem(MUTE_KEY) === "1";
}

function volume(): number {
  if (typeof window === "undefined") return 0;
  const value = Number(localStorage.getItem(VOLUME_KEY));
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0.25;
}

function events(): Record<SoundEvent, boolean> {
  if (typeof window === "undefined") return DEFAULT_EVENTS;
  try {
    return { ...DEFAULT_EVENTS, ...JSON.parse(localStorage.getItem(EVENTS_KEY) || "{}") };
  } catch {
    return DEFAULT_EVENTS;
  }
}

export function getVolume(): number { return volume(); }

export function setVolume(value: number): number {
  const next = Math.min(1, Math.max(0, Number(value) || 0));
  localStorage.setItem(VOLUME_KEY, String(next));
  return next;
}

export function isSoundEnabled(event: SoundEvent): boolean {
  return events()[event];
}

export function setSoundEnabled(event: SoundEvent, enabled: boolean): boolean {
  const next = { ...events(), [event]: enabled };
  localStorage.setItem(EVENTS_KEY, JSON.stringify(next));
  return enabled;
}

export function toggleMute(): boolean {
  const next = !muted();
  localStorage.setItem(MUTE_KEY, next ? "1" : "0");
  return next;
}

export function isMuted(): boolean {
  return muted();
}

function pop(freq: number, start: number, dur: number, vol: number) {
  if (muted()) return;
  const c = getCtx();
  if (!c) return;
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = "sine";
  o.frequency.setValueAtTime(freq, c.currentTime + start);
  g.gain.setValueAtTime(0, c.currentTime + start);
  g.gain.linearRampToValueAtTime(vol * volume(), c.currentTime + start + 0.015);
  g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + start + dur);
  o.connect(g);
  g.connect(c.destination);
  o.start(c.currentTime + start);
  o.stop(c.currentTime + start + dur);
}

function noise(dur: number, vol: number) {
  if (muted()) return;
  const c = getCtx();
  if (!c) return;
  const buf = c.createBuffer(1, c.sampleRate * dur, c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1);
  const src = c.createBufferSource();
  src.buffer = buf;
  const g = c.createGain();
  g.gain.setValueAtTime(vol * volume(), c.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + dur);
  src.connect(g);
  g.connect(c.destination);
  src.start();
}

export function playChatResponse() {
  if (!isSoundEnabled("leads")) return;
  pop(620, 0, 0.12, 0.13);
  pop(820, 0.07, 0.12, 0.09);
}

export function playMessageSent() {
  if (!isSoundEnabled("whatsapp")) return;
  pop(440, 0, 0.06, 0.06);
}

export function playNewWhatsApp() {
  if (!isSoundEnabled("whatsapp")) return;
  pop(480, 0, 0.1, 0.1);
}

export function playNewLead() {
  if (!isSoundEnabled("leads")) return;
  pop(700, 0, 0.18, 0.1);
  pop(920, 0.1, 0.2, 0.07);
}

export function playConnectionChange() {
  if (!isSoundEnabled("connection")) return;
  noise(0.15, 0.04);
  pop(550, 0, 0.2, 0.08);
}

export function playGroupConnected() {
  if (!isSoundEnabled("groups")) return;
  pop(660, 0, 0.1, 0.12);
  pop(880, 0.06, 0.1, 0.1);
  pop(1100, 0.12, 0.15, 0.07);
}
