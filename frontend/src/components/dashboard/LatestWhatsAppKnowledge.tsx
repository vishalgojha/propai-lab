interface LatestWhatsAppKnowledgeProps {
  feed: any[];
  onOpenInbox: () => void;
}

const badgeColorByIntent: Record<string, string> = {
  SELL: "green",
  BUY: "purple",
  RENT: "yellow",
};

function cleanWhatsAppText(value = "") {
  return value
    .replace(/[*_~`]+/g, "")
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, " ")
    .replace(/={3,}[^a-zA-Z0-9]*\d{1,2}[^a-zA-Z0-9]*\d{1,2}[^a-zA-Z0-9]*\d{2,4}[^a-zA-Z0-9]*={3,}/g, " ")
    .replace(/[=•●▪▫◾◽]{3,}/g, " ")
    .replace(/\b(for\s+)?inspection\b.*$/i, "")
    .replace(/\b(call|contact)\s+[\d+\s-]{8,}.*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanGroupName(value = "") {
  const cleaned = value.replace(/@\w+(\.\w+)?$/g, "").trim();
  if (/^\d{12,}/.test(cleaned)) return "";
  return cleaned;
}

function cleanBrokerName(value = "") {
  const cleaned = value
    .replace(/\s*\([^)]*\d[^)]*\)\s*/g, "")
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned || cleaned.length < 2 || /^\+?\d/.test(cleaned) || /X{3,}/i.test(cleaned)) return "WhatsApp source";
  return cleaned;
}

function safeTimeLabel(value?: string) {
  if (!value) return "";
  const date = new Date(value.endsWith("Z") ? value : `${value}Z`);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatAmount(raw: string, unit: string) {
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value)) return "";
  if (/cr/i.test(unit)) return `₹${value.toLocaleString("en-IN", { maximumFractionDigits: 2 })} Cr`;
  if (/lac|lakh|lacs|lakhs|l\b/i.test(unit)) return `₹${value.toLocaleString("en-IN", { maximumFractionDigits: 2 })} L`;
  if (/k/i.test(unit)) return `₹${value.toLocaleString("en-IN", { maximumFractionDigits: 2 })} K`;
  return `₹${value.toLocaleString("en-IN")}`;
}

function extractLocation(text: string) {
  const known = [
    "Bandra West",
    "Bandra East",
    "Bandra",
    "Khar West",
    "Khar",
    "Juhu",
    "Santacruz",
    "Andheri West",
    "Andheri East",
    "BKC",
    "Worli",
    "Lower Parel",
    "Goregaon",
  ];
  const lower = text.toLowerCase();
  return known.find((place) => lower.includes(place.toLowerCase())) || "";
}

function formatFeedMessage(raw = "") {
  const text = cleanWhatsAppText(raw);
  if (!text) return "No readable message text";

  const parts: string[] = [];
  const bhk = text.match(/\b(\d+(?:\.\d+)?)\s*BHK\b/i)?.[0]?.toUpperCase();
  if (bhk) parts.push(bhk);

  const location = extractLocation(text);
  if (location) parts.push(location);

  const area = text.match(/\b(\d{3,5})\s*(?:sq\s*ft|sqft|sft|carpet|cpt)\b/i);
  if (area) parts.push(`${Number(area[1]).toLocaleString("en-IN")} sqft`);

  const rent = text.match(/\b(?:rent|asking|price)?\s*(\d+(?:\.\d+)?)\s*(lacs?|lakhs?|lakh|lac|l|cr|crore|k)\b/i);
  if (rent) parts.push(formatAmount(rent[1], rent[2]));

  const furnishing = text.match(/\b(fully furnished|semi furnished|unfurnished|furnished)\b/i)?.[1];
  if (furnishing) parts.push(furnishing.replace(/\b\w/g, (ch) => ch.toUpperCase()));

  const compact = parts.length >= 2 ? parts.join(" · ") : text;
  const tail = text
    .replace(/\bavailable\b/gi, "")
    .replace(/\bfor\s+(rent|lease|sale)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  if (parts.length >= 2) {
    return `${compact}${tail ? ` - ${tail.slice(0, 120)}` : ""}`;
  }
  return compact.slice(0, 180);
}

function KnowledgeRow({ item, index }: { item: any; index: number }) {
  const intent = item.intent || "TEXT";
  const color = badgeColorByIntent[intent] || "blue";
  const message = formatFeedMessage(item.message || "");
  const group = cleanGroupName(item.group_name || "");
  const broker = cleanBrokerName(item.broker_name || "");
  const time = safeTimeLabel(item.timestamp);

  return (
    <div key={index} className="feed-item">
      <div className="feed-header">
        <span className={`badge badge-${color}`}>{intent}</span>
        <span className="font-semibold text-[#f0f6fc] text-xs">{broker}</span>
        {time && <span className="feed-time">{time}</span>}
        {group && <span className="feed-group">{group.slice(0, 28)}</span>}
      </div>
      <div className="feed-msg">{message.slice(0, 220)}</div>
    </div>
  );
}

export function LatestWhatsAppKnowledge({ feed, onOpenInbox }: LatestWhatsAppKnowledgeProps) {
  return (
    <section className="border border-white/10 rounded-2xl p-5">
      <div className="flex items-center justify-between mb-3">
        <div className="text-[11px] text-zinc-500 uppercase tracking-widest font-bold">LATEST WHATSAPP KNOWLEDGE</div>
        <button
          onClick={onOpenInbox}
          className="text-[10px] text-blue-300 hover:text-white"
        >
          Open inbox
        </button>
      </div>
      <div className="max-h-[240px] overflow-y-auto">
        {feed.length === 0 ? (
          <div className="text-zinc-500 text-center py-5">No messages yet</div>
        ) : (
          feed.map((item, index) => <KnowledgeRow key={`${item.id || item.timestamp || "feed"}-${index}`} item={item} index={index} />)
        )}
      </div>
    </section>
  );
}
