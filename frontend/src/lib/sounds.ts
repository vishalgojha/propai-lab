const MUTE_KEY = "propai_sounds_muted";

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
  g.gain.linearRampToValueAtTime(vol, c.currentTime + start + 0.015);
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
  g.gain.setValueAtTime(vol, c.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + dur);
  src.connect(g);
  g.connect(c.destination);
  src.start();
}

export function playChatResponse() {
  pop(620, 0, 0.12, 0.13);
  pop(820, 0.07, 0.12, 0.09);
}

export function playMessageSent() {
  pop(440, 0, 0.06, 0.06);
}

export function playNewWhatsApp() {
  pop(480, 0, 0.1, 0.1);
}

export function playNewLead() {
  pop(700, 0, 0.18, 0.1);
  pop(920, 0.1, 0.2, 0.07);
}

export function playConnectionChange() {
  noise(0.15, 0.04);
  pop(550, 0, 0.2, 0.08);
}

export function playGroupConnected() {
  pop(660, 0, 0.1, 0.12);
  pop(880, 0.06, 0.1, 0.1);
  pop(1100, 0.12, 0.15, 0.07);
}
