// A failed probe is not a confirmed disconnect. Keep this separate from
// isLiveWhatsAppConnection, which intentionally answers only yes/no.
type Status = {
  connected?: boolean | null;
  state?: string | null;
  connection_state?: string | null;
  status_stale?: boolean;
};
type PhoneStatus = Status & { live_status_available?: boolean };

export function confirmedConnection(status: Status | null | undefined): boolean | null {
  if (!status || status.status_stale) return null;
  const state = String(status.state || status.connection_state || "").trim().toLowerCase();
  if (["unknown", "unavailable", "checking", "error"].includes(state)) return null;
  const open = ["open", "connected"].includes(state);
  const closed = ["closed", "disconnected", "stopped", "logged_out", "loggedout", "connecting", "qr", "pairing"].includes(state);
  if ((status.connected === false && open) || (status.connected === true && closed)) return null;
  if (status.connected === true || open) return true;
  if (status.connected === false && closed) return false;
  return null;
}

export function workspaceConnection(phones: PhoneStatus[], status: Status | null): boolean | null {
  const perPhone = phones.map(phone => phone.live_status_available === true ? confirmedConnection(phone) : null);
  if (perPhone.includes(true)) return true;
  const current = confirmedConnection(status);
  if (current !== null) return current;
  // A partial response must not claim every configured phone is disconnected.
  return perPhone.length > 0 && perPhone.every(value => value === false) ? false : null;
}

export function identityOnlyPhones<T extends PhoneStatus>(phones: T[]): T[] {
  return phones.map(phone => ({ ...phone, live_status_available: false }));
}
