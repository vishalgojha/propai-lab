// Optional "join our WhatsApp group" invite shown to signed-in brokers.
// Joining is the broker's own choice: this only renders a plain link.
// The link can be swapped with NEXT_PUBLIC_BROKER_GROUP_INVITE_URL.
export const DEFAULT_BROKER_GROUP_INVITE_URL = "https://chat.whatsapp.com/IDQbF12NdrCEq0VOqQpS1l";

const INVITE_RE = /^https:\/\/chat\.whatsapp\.com\/([A-Za-z0-9]{10,40})\/?$/;

/** Returns a clean https://chat.whatsapp.com/<code> link, or null if the value is not one. */
export function cleanGroupInviteUrl(value?: string | null): string | null {
  const raw = (value || "").trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const bare = `${url.protocol}//${url.host}${url.pathname}`;
  const m = INVITE_RE.exec(bare);
  return m ? `https://chat.whatsapp.com/${m[1]}` : null;
}

export function brokerGroupInviteUrl(): string | null {
  return cleanGroupInviteUrl(process.env.NEXT_PUBLIC_BROKER_GROUP_INVITE_URL || DEFAULT_BROKER_GROUP_INVITE_URL);
}
