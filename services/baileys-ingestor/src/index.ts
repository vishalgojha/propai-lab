import "dotenv/config";

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
const INSTANCE_NAME = process.env.PROPAI_INSTANCE_NAME || "propai-baileys";
const AUTH_DIR = process.env.BAILEYS_AUTH_DIR || "auth";
const INGEST_PRIVATE_CHATS = parseBool(process.env.PROPAI_INGEST_PRIVATE_CHATS, false);
const CAPTURE_HISTORY_SYNC = parseBool(process.env.PROPAI_CAPTURE_HISTORY_SYNC, false);
const GROUP_ALLOWLIST = parseList(process.env.PROPAI_GROUP_ALLOWLIST);
const GROUP_DENYLIST = parseList(process.env.PROPAI_GROUP_DENYLIST);

const logger = Pino({ level: process.env.LOG_LEVEL || "info" });
const groupNames = new Map<string, string>();

type OutboundMessage = {
  event: "MESSAGES_UPSERT" | "MESSAGES_SET";
  instance: string;
  data: {
    key: WAMessage["key"];
    message: NonNullable<WAMessage["message"]>;
    messageTimestamp?: number;
    sender: {
      id: string;
      pushName: string;
      name: string;
    };
  };
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
  return jid === "status@broadcast" || jid.endsWith("@broadcast") || jid === "broadcast";
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

  const text = textFromMessage(message.message);
  if (!text) return;

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

async function refreshGroups(sock: ReturnType<typeof makeWASocket>) {
  try {
    const groups = await sock.groupFetchAllParticipating();
    groupNames.clear();
    for (const [jid, metadata] of Object.entries(groups)) {
      groupNames.set(jid, metadata.subject || jid);
    }
    logger.info({ groups: groupNames.size }, "group cache refreshed");
  } catch (error) {
    logger.warn({ error }, "failed to refresh group cache");
  }
}

async function connect() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();
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
    }

    if (connection === "open") {
      logger.info("whatsapp connection open");
      await refreshGroups(sock);
    }

    if (connection === "close") {
      const statusCode = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;
      logger.warn({ statusCode, loggedOut }, "whatsapp connection closed");
      if (!loggedOut) {
        setTimeout(() => void connect(), 2000);
      }
    }
  });

  sock.ev.on("groups.update", (updates) => {
    for (const update of updates) {
      if (update.id && update.subject) groupNames.set(update.id, update.subject);
    }
  });

  sock.ev.on("messages.upsert", async ({ messages }) => {
    for (const message of messages) {
      try {
        await forwardMessage(message, "MESSAGES_UPSERT");
      } catch (error) {
        logger.error({ error }, "failed to forward live message");
      }
    }
  });

  sock.ev.on("messaging-history.set", async ({ messages }) => {
    if (!CAPTURE_HISTORY_SYNC) return;
    logger.info({ messages: messages.length }, "received history sync batch");
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
