import "dotenv/config";
import fs from "fs";
import path from "path";

import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  proto,
  useMultiFileAuthState,
  type AnyMessageContent,
  type WAMessage,
} from "@whiskeysockets/baileys";
import Pino from "pino";
import qrcode from "qrcode-terminal";

const WEBHOOK_URL = process.env.PROPAI_WEBHOOK_URL || "http://localhost:8000/webhook";
const PROPAI_API_URL = process.env.PROPAI_API_URL || WEBHOOK_URL.replace(/\/webhook\/?$/, "");
const SELF_CHAT_URL = process.env.PROPAI_SELF_CHAT_URL || `${PROPAI_API_URL}/api/baileys/self-chat`;
const INSTANCE_NAME = process.env.PROPAI_INSTANCE_NAME || "propai-baileys";
const AUTH_DIR = process.env.BAILEYS_AUTH_DIR || "auth";
const STATUS_FILE = process.env.BAILEYS_STATUS_FILE || path.resolve(AUTH_DIR, "status.json");
const INGEST_PRIVATE_CHATS = parseBool(process.env.PROPAI_INGEST_PRIVATE_CHATS, false);
const ENABLE_SELF_CHAT_AGENT = parseBool(process.env.PROPAI_ENABLE_SELF_CHAT_AGENT, true);
const CAPTURE_HISTORY_SYNC = parseBool(process.env.PROPAI_CAPTURE_HISTORY_SYNC, false);
const GROUP_ALLOWLIST = parseList(process.env.PROPAI_GROUP_ALLOWLIST);
const GROUP_DENYLIST = parseList(process.env.PROPAI_GROUP_DENYLIST);
const AGENT_PREFIX = "PropAI agent:";

const logger = Pino({ level: process.env.LOG_LEVEL || "info" });
const groupNames = new Map<string, string>();
const handledSelfChatMessages: string[] = [];
const handledSelfChatMessageIds = new Set<string>();
const selfChatHistory = new Map<string, Array<{ role: "user" | "assistant"; content: string }>>();

type OutboundMessage = {
  event: "MESSAGES_UPSERT" | "MESSAGES_SET" | "GROUPS_REFRESHED";
  instance: string;
  data?: {
    key: WAMessage["key"];
    message: NonNullable<WAMessage["message"]>;
    messageTimestamp?: number;
    sender: {
      id: string;
      pushName: string;
      name: string;
    };
  };
  groups?: Array<{ id: string; name: string; participants: number }>;
};

function parseBool(value: string | undefined, fallback: boolean) {
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "y", "on"].includes(value.toLowerCase());
}

function parseList(value: string | undefined) {
  return (value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function isGroupJid(jid = "") {
  return jid.endsWith("@g.us");
}

function isBroadcastOrStatus(jid = "") {
  return jid === "status@broadcast" || jid.endsWith("@broadcast") || jid.endsWith("@newsletter") || jid === "broadcast";
}

function jidUser(jid = "") {
  return jid.split("@")[0]?.split(":")[0] || "";
}

function isOwnChatJid(jid: string, sock: ReturnType<typeof makeWASocket>) {
  if (!jid || isGroupJid(jid) || isBroadcastOrStatus(jid)) return false;
  const remoteUser = jidUser(jid);
  if (!remoteUser) return false;

  const ownIds = [
    sock.user?.id,
    (sock.user as { lid?: string; jid?: string } | undefined)?.lid,
    (sock.user as { lid?: string; jid?: string } | undefined)?.jid,
  ].filter(Boolean) as string[];

  return ownIds.some((ownId) => jidUser(ownId) === remoteUser);
}

function appendSelfChatHistory(remoteJid: string, role: "user" | "assistant", content: string) {
  const clean = content.trim();
  if (!remoteJid || !clean) return;
  const history = selfChatHistory.get(remoteJid) || [];
  history.push({ role, content: clean.slice(0, 1800) });
  selfChatHistory.set(remoteJid, history.slice(-10));
}

function getSelfChatHistory(remoteJid: string) {
  return selfChatHistory.get(remoteJid) || [];
}

function normalizeMatch(value = "") {
  return value.toLowerCase();
}

function groupAllowed(jid: string) {
  if (!isGroupJid(jid)) return INGEST_PRIVATE_CHATS && !isBroadcastOrStatus(jid);

  const name = groupNames.get(jid) || "";
  const searchable = `${jid} ${name}`.toLowerCase();

  if (GROUP_DENYLIST.some((item) => searchable.includes(normalizeMatch(item)))) {
    return false;
  }

  if (GROUP_ALLOWLIST.length === 0) {
    return true;
  }

  return GROUP_ALLOWLIST.some((item) => searchable.includes(normalizeMatch(item)));
}

function writeStatus(partial: Record<string, unknown>) {
  try {
    fs.mkdirSync(path.dirname(STATUS_FILE), { recursive: true });
    fs.writeFileSync(
      STATUS_FILE,
      JSON.stringify(
        {
          instance: INSTANCE_NAME,
          source: "baileys",
          updated_at: new Date().toISOString(),
          ...partial,
        },
        null,
        2
      )
    );
  } catch (error) {
    logger.warn({ error }, "failed to write baileys status");
  }
}

function messageTimestampSeconds(message: WAMessage) {
  const raw = message.messageTimestamp;
  if (typeof raw === "number") return raw;
  if (typeof raw === "string") return Number(raw);
  if (raw && typeof raw === "object" && "toNumber" in raw && typeof raw.toNumber === "function") {
    return raw.toNumber();
  }
  return Math.floor(Date.now() / 1000);
}

function unwrapMessage(message: proto.IMessage | null | undefined): proto.IMessage | undefined {
  let current = message || undefined;
  for (let i = 0; i < 4; i += 1) {
    const next =
      current?.ephemeralMessage?.message ||
      current?.viewOnceMessage?.message ||
      current?.viewOnceMessageV2?.message ||
      current?.documentWithCaptionMessage?.message;
    if (!next) break;
    current = next;
  }
  return current;
}

function textFromMessage(message: proto.IMessage | null | undefined) {
  const inner = unwrapMessage(message);
  return (
    inner?.conversation ||
    inner?.extendedTextMessage?.text ||
    inner?.imageMessage?.caption ||
    inner?.videoMessage?.caption ||
    inner?.documentMessage?.caption ||
    inner?.buttonsResponseMessage?.selectedDisplayText ||
    inner?.listResponseMessage?.title ||
    inner?.templateButtonReplyMessage?.selectedDisplayText ||
    ""
  ).trim();
}

function senderJid(message: WAMessage) {
  return message.key.participant || message.participant || message.key.remoteJid || "";
}

function senderName(message: WAMessage) {
  return (message.pushName || "").trim();
}

function messageDedupeKey(message: WAMessage) {
  return [
    message.key.remoteJid || "",
    message.key.id || "",
    messageTimestampSeconds(message),
  ].join("::");
}

function rememberSelfChatMessage(key: string) {
  if (handledSelfChatMessageIds.has(key)) return false;
  handledSelfChatMessageIds.add(key);
  handledSelfChatMessages.push(key);
  while (handledSelfChatMessages.length > 500) {
    const stale = handledSelfChatMessages.shift();
    if (stale) handledSelfChatMessageIds.delete(stale);
  }
  return true;
}

async function postToPropAI(payload: OutboundMessage) {
  const response = await fetch(WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`PropAI webhook failed: ${response.status} ${response.statusText}: ${body}`);
  }
}

async function forwardMessage(message: WAMessage, event: OutboundMessage["event"]) {
  const remoteJid = message.key.remoteJid || "";
  if (!remoteJid || !message.message || message.key.fromMe) return;
  if (!groupAllowed(remoteJid)) return;

  const isDm = !isGroupJid(remoteJid) && !isBroadcastOrStatus(remoteJid);
  const text = textFromMessage(message.message);
  if (!isDm && !text) return;

  await postToPropAI({
    event,
    instance: INSTANCE_NAME,
    data: {
      key: message.key,
      message: message.message,
      messageTimestamp: messageTimestampSeconds(message),
      sender: {
        id: senderJid(message),
        pushName: senderName(message),
        name: senderName(message),
      },
    },
  });

  logger.debug({ remoteJid, sender: senderName(message), chars: text.length }, "forwarded message");
}

async function askSelfChatAgent(message: WAMessage, sock: ReturnType<typeof makeWASocket>) {
  if (!ENABLE_SELF_CHAT_AGENT || !message.key.fromMe || !message.message) return false;

  const remoteJid = message.key.remoteJid || "";
  if (!isOwnChatJid(remoteJid, sock)) return false;

  const text = textFromMessage(message.message);
  if (!text || text.startsWith(AGENT_PREFIX)) return true;

  const key = messageDedupeKey(message);
  if (!rememberSelfChatMessage(key)) return true;

  try {
    logger.info({ chars: text.length, remoteJid }, "self-chat agent query");
    const priorMessages = getSelfChatHistory(remoteJid);
    const response = await fetch(SELF_CHAT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        remote_jid: remoteJid,
        sender_jid: senderJid(message),
        message_id: message.key.id || "",
        push_name: senderName(message),
        messages: [...priorMessages, { role: "user", content: text }],
      }),
    });

    let payload: { reply?: string; error?: unknown } = {};
    const responseBody = await response.text();
    try {
      payload = responseBody ? JSON.parse(responseBody) as { reply?: string; error?: unknown } : {};
    } catch {
      payload = { reply: responseBody };
    }

    const rawReply = (payload.reply || "").trim();
    const reply = rawReply || `I could not answer that. ${response.ok ? "" : `PropAI API returned ${response.status}.`}`.trim();
    if (!reply) return true;

    await sock.sendMessage(remoteJid, { text: `${AGENT_PREFIX} ${reply}` } satisfies AnyMessageContent);
    appendSelfChatHistory(remoteJid, "user", text);
    appendSelfChatHistory(remoteJid, "assistant", reply);
    logger.info({ remoteJid, status: response.status }, "self-chat agent replied");
  } catch (error) {
    logger.error({ error }, "self-chat agent failed");
    appendSelfChatHistory(remoteJid, "user", text);
    appendSelfChatHistory(remoteJid, "assistant", "I could not reach the PropAI database right now.");
    await sock.sendMessage(remoteJid, {
      text: `${AGENT_PREFIX} I could not reach the PropAI database right now.`,
    } satisfies AnyMessageContent);
  }

  return true;
}

async function postGroupsToPropAI() {
  const groupList = Array.from(groupNames.entries()).map(([id, name]) => ({
    id,
    name,
    participants: 0,
  }));
  try {
    const payload: OutboundMessage = {
      event: "GROUPS_REFRESHED",
      instance: INSTANCE_NAME,
      groups: groupList,
    };
    const response = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      logger.warn({ status: response.status }, "failed to post groups to PropAI");
    } else {
      logger.info({ groups: groupList.length }, "groups synced to PropAI");
    }
  } catch (error) {
    logger.warn({ error }, "failed to post groups to PropAI");
  }
}

async function refreshGroups(sock: ReturnType<typeof makeWASocket>) {
  try {
    const groups = await sock.groupFetchAllParticipating();
    groupNames.clear();
    for (const [jid, metadata] of Object.entries(groups)) {
      groupNames.set(jid, metadata.subject || jid);
    }
    logger.info({ groups: groupNames.size }, "group cache refreshed");
    await postGroupsToPropAI();
  } catch (error) {
    logger.warn({ error }, "failed to refresh group cache");
  }
}

async function connect() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();
  writeStatus({ connected: false, connection_state: "connecting" });
  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    logger,
    browser: Browsers.macOS("PropAI"),
    markOnlineOnConnect: false,
    syncFullHistory: CAPTURE_HISTORY_SYNC,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      logger.info("scan this QR with WhatsApp");
      qrcode.generate(qr, { small: true });
      writeStatus({ connected: false, connection_state: "qr", qr_available: true });
    }

    if (connection === "open") {
      logger.info("whatsapp connection open");
      await refreshGroups(sock);
      writeStatus({
        connected: true,
        connection_state: "open",
        phone_number: sock.user?.id || "",
        display_name: sock.user?.name || "",
        instance_name: INSTANCE_NAME,
        self_chat_agent: ENABLE_SELF_CHAT_AGENT,
      });
    }

    if (connection === "close") {
      const statusCode = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;
      logger.warn({ statusCode, loggedOut }, "whatsapp connection closed");
      writeStatus({
        connected: false,
        connection_state: loggedOut ? "logged_out" : "closed",
        disconnect_reason: statusCode || null,
      });
      if (!loggedOut) {
        setTimeout(() => void connect(), 2000);
      }
    }
  });

  sock.ev.on("groups.update", (updates) => {
    for (const update of updates) {
      if (update.id && update.subject) groupNames.set(update.id, update.subject);
    }
    postGroupsToPropAI();
  });

  sock.ev.on("messages.upsert", async ({ messages }) => {
    for (const message of messages) {
      try {
        if (await askSelfChatAgent(message, sock)) continue;
        await forwardMessage(message, "MESSAGES_UPSERT");
      } catch (error) {
        logger.error({ error }, "failed to forward live message");
      }
    }
  });

  sock.ev.on("messaging-history.set", async ({ messages }) => {
    if (!CAPTURE_HISTORY_SYNC) return;
    logger.info({ messages: messages.length }, "received history sync batch");
    writeStatus({ history_sync: true });
    for (const message of messages) {
      try {
        await forwardMessage(message, "MESSAGES_SET");
      } catch (error) {
        logger.error({ error }, "failed to forward history message");
      }
    }
  });

  return sock;
}

process.on("SIGINT", () => {
  logger.info("shutdown requested");
  process.exit(0);
});

void connect().catch((error) => {
  logger.fatal({ error }, "baileys ingestor failed");
  process.exit(1);
});
