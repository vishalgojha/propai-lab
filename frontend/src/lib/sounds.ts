const MUTE_KEY = "propai_sounds_muted";
const VOLUME_KEY = "propai_sounds_volume";
const EVENTS_KEY = "propai_sounds_events";
const NOTIFICATION_SOUND = "/sounds/notify-chime.ogg";

export type SoundEvent = "whatsapp" | "groups" | "connection" | "leads";
const DEFAULT_EVENTS: Record<SoundEvent, boolean> = {
  whatsapp: true,
  groups: false,
  connection: true,
  leads: true,
};

let notificationAudio: HTMLAudioElement | null = null;

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

function playNotificationSound() {
  const level = volume();
  if (muted() || level <= 0 || typeof window === "undefined") return;
  if (!notificationAudio) {
    notificationAudio = new Audio(NOTIFICATION_SOUND);
    notificationAudio.preload = "auto";
  }
  notificationAudio.volume = level;
  notificationAudio.currentTime = 0;
  void notificationAudio.play().catch(() => {
    // Browsers may block playback until the user has interacted with the app.
  });
}

export function playChatResponse() {
  if (!isSoundEnabled("leads")) return;
  playNotificationSound();
}

export function playMessageSent() {
  if (!isSoundEnabled("whatsapp")) return;
  playNotificationSound();
}

export function playNewWhatsApp() {
  if (!isSoundEnabled("whatsapp")) return;
  playNotificationSound();
}

export function playNewLead() {
  if (!isSoundEnabled("leads")) return;
  playNotificationSound();
}

export function playConnectionChange() {
  if (!isSoundEnabled("connection")) return;
  playNotificationSound();
}

export function playGroupConnected() {
  if (!isSoundEnabled("groups")) return;
  playNotificationSound();
}
