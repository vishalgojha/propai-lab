const MUTE_KEY = "propai_sounds_muted";
const VOLUME_KEY = "propai_sounds_volume";
const EVENTS_KEY = "propai_sounds_events";
const PREFERENCES_KEY = "propai_sounds_preferences";

export type SoundEvent = "whatsapp" | "groups" | "connection" | "leads";
export type SoundId = "default" | "chime" | "pop" | "ding" | "bell" | "soft-ding" | "soft-alert";
export type SoundPreferences = Record<SoundEvent, SoundId>;

export const SOUND_LIBRARY: { id: SoundId; label: string; file?: string }[] = [
  { id: "default", label: "Default", file: "chime.wav" },
  { id: "chime", label: "Chime", file: "chime.wav" },
  { id: "pop", label: "Pop", file: "pop.wav" },
  { id: "ding", label: "Ding", file: "ding.wav" },
  { id: "bell", label: "Bell", file: "bell.wav" },
  { id: "soft-ding", label: "Soft Ding", file: "soft-ding.wav" },
  { id: "soft-alert", label: "Soft Alert", file: "soft-alert.wav" },
];

const DEFAULT_EVENTS: Record<SoundEvent, boolean> = {
  whatsapp: true,
  groups: false,
  connection: true,
  leads: true,
};

const DEFAULT_PREFERENCES: SoundPreferences = {
  whatsapp: "chime",
  groups: "pop",
  connection: "bell",
  leads: "soft-ding",
};

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

function preferences(): SoundPreferences {
  if (typeof window === "undefined") return DEFAULT_PREFERENCES;
  try {
    return { ...DEFAULT_PREFERENCES, ...JSON.parse(localStorage.getItem(PREFERENCES_KEY) || "{}") };
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

function soundFile(id: SoundId): string {
  return SOUND_LIBRARY.find((sound) => sound.id === id)?.file || "chime.wav";
}

export function getVolume(): number { return volume(); }

export function setVolume(value: number): number {
  const next = Math.min(1, Math.max(0, Number(value) || 0));
  localStorage.setItem(VOLUME_KEY, String(next));
  return next;
}

export function isSoundEnabled(event: SoundEvent): boolean { return events()[event]; }

export function setSoundEnabled(event: SoundEvent, enabled: boolean): boolean {
  const next = { ...events(), [event]: enabled };
  localStorage.setItem(EVENTS_KEY, JSON.stringify(next));
  return enabled;
}

export function getSoundPreferences(): SoundPreferences { return preferences(); }

export function setSoundPreference(event: SoundEvent, sound: SoundId): SoundPreferences {
  const next = { ...preferences(), [event]: sound };
  localStorage.setItem(PREFERENCES_KEY, JSON.stringify(next));
  return next;
}

export function loadSoundPreferences(value: Partial<SoundPreferences> | null | undefined): SoundPreferences {
  const next = { ...DEFAULT_PREFERENCES, ...(value || {}) };
  localStorage.setItem(PREFERENCES_KEY, JSON.stringify(next));
  return next;
}

export function toggleMute(): boolean {
  const next = !muted();
  localStorage.setItem(MUTE_KEY, next ? "1" : "0");
  return next;
}

export function isMuted(): boolean { return muted(); }

function playFile(id: SoundId, force = false): void {
  if (!force && muted()) return;
  if (typeof window === "undefined") return;
  const audio = new Audio(`/sounds/${soundFile(id)}`);
  audio.volume = volume();
  void audio.play().catch(() => undefined);
}

export function previewSound(sound: SoundId): void { playFile(sound, true); }

export function playSound(event: SoundEvent): void {
  if (!isSoundEnabled(event)) return;
  playFile(preferences()[event]);
}

export function playChatResponse(): void { playSound("leads"); }
export function playMessageSent(): void { playSound("whatsapp"); }
export function playNewWhatsApp(): void { playSound("whatsapp"); }
export function playNewLead(): void { playSound("leads"); }
export function playConnectionChange(): void { playSound("connection"); }
export function playGroupConnected(): void { playSound("groups"); }
