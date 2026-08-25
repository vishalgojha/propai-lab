type ChatMessage = {
  role: "system" | "user";
  content: string;
};

type ThreadSummary = {
  summary: string;
  next_action: string;
  key_points: string[];
};

export type ThreadActionExtraction = {
  requirements: Array<{
    title: string;
    raw_text: string;
    location_pref?: string;
    budget?: string;
    timeline?: string;
  }>;
  listings: Array<{
    title: string;
    raw_text: string;
    location?: string;
    price?: string;
    bhk?: string;
  }>;
  follow_ups: Array<{
    lead_name: string;
    lead_phone?: string;
    notes: string;
    priority_bucket?: "P1" | "P2" | "P3";
  }>;
  unresolved_questions: string[];
  recommended_actions: string[];
};

export type GrowthDraft = {
  title: string;
  body: string;
  CTA: string;
  angle: string;
};

const OPENROUTER_BASE_URL = process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1";
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || "openai/gpt-4o-mini";
const GROQ_BASE_URL = process.env.GROQ_BASE_URL || "https://api.groq.com/openai/v1";
const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";

function fallbackSummary(lines: string[]): ThreadSummary {
  const recent = lines.slice(-5);
  return {
    summary: recent.length
      ? `Recent thread activity captured across ${recent.length} messages.`
      : "No meaningful thread history found.",
    next_action: recent.length
      ? "Review the latest asks, confirm availability, and send the broker a concise follow-up."
      : "Ask the broker to load or sync more thread history before summarizing.",
    key_points: recent,
  };
}

async function callOpenAICompatible(
  baseURL: string,
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  extraHeaders?: Record<string, string>,
) {
  const response = await fetch(`${baseURL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      ...extraHeaders,
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`LLM request failed: ${response.status} ${text.slice(0, 240)}`);
  }

  const data = await response.json() as {
    choices?: Array<{ message?: { content?: string | null } }>;
  };
  return String(data.choices?.[0]?.message?.content || "").trim();
}

function parseSummary(raw: string, fallback: ThreadSummary) {
  try {
    const parsed = JSON.parse(raw) as Partial<ThreadSummary>;
    const summary = String(parsed.summary || "").trim();
    const nextAction = String(parsed.next_action || "").trim();
    const keyPoints = Array.isArray(parsed.key_points)
      ? parsed.key_points.map((item) => String(item).trim()).filter(Boolean).slice(0, 5)
      : [];

    if (!summary || !nextAction || !keyPoints.length) {
      return fallback;
    }

    return {
      summary,
      next_action: nextAction,
      key_points: keyPoints,
    };
  } catch {
    return fallback;
  }
}

function fallbackThreadActions(lines: string[]): ThreadActionExtraction {
  const last = lines.slice(-6);
  return {
    requirements: [],
    listings: [],
    follow_ups: last.length
      ? [{
          lead_name: "Thread follow-up",
          notes: "Review the latest thread manually and confirm what should be saved into CRM.",
          priority_bucket: "P2",
        }]
      : [],
    unresolved_questions: last.length
      ? ["The thread needs manual review to confirm whether it contains a buyer requirement, listing, or callback ask."]
      : ["No usable thread history found."],
    recommended_actions: last.length
      ? ["Review the latest messages and save any clear requirement or listing manually."]
      : ["Sync or load more thread history before extracting actions."],
  };
}

function parseThreadActions(raw: string, fallback: ThreadActionExtraction) {
  try {
    const parsed = JSON.parse(raw) as Partial<ThreadActionExtraction>;
    const requirements = Array.isArray(parsed.requirements)
      ? parsed.requirements
        .map((item) => ({
          title: String(item?.title || "").trim(),
          raw_text: String(item?.raw_text || "").trim(),
          location_pref: item?.location_pref ? String(item.location_pref).trim() : undefined,
          budget: item?.budget ? String(item.budget).trim() : undefined,
          timeline: item?.timeline ? String(item.timeline).trim() : undefined,
        }))
        .filter((item) => item.title && item.raw_text)
        .slice(0, 3)
      : [];
    const listings = Array.isArray(parsed.listings)
      ? parsed.listings
        .map((item) => ({
          title: String(item?.title || "").trim(),
          raw_text: String(item?.raw_text || "").trim(),
          location: item?.location ? String(item.location).trim() : undefined,
          price: item?.price ? String(item.price).trim() : undefined,
          bhk: item?.bhk ? String(item.bhk).trim() : undefined,
        }))
        .filter((item) => item.title && item.raw_text)
        .slice(0, 3)
      : [];
    const followUps = Array.isArray(parsed.follow_ups)
      ? parsed.follow_ups
        .map((item) => ({
          lead_name: String(item?.lead_name || "").trim(),
          lead_phone: item?.lead_phone ? String(item.lead_phone).trim() : undefined,
          notes: String(item?.notes || "").trim(),
          priority_bucket: item?.priority_bucket === "P1" || item?.priority_bucket === "P2" || item?.priority_bucket === "P3"
            ? item.priority_bucket
            : undefined,
        }))
        .filter((item) => item.lead_name && item.notes)
        .slice(0, 5)
      : [];
    const unresolvedQuestions = Array.isArray(parsed.unresolved_questions)
      ? parsed.unresolved_questions.map((item) => String(item).trim()).filter(Boolean).slice(0, 5)
      : [];
    const recommendedActions = Array.isArray(parsed.recommended_actions)
      ? parsed.recommended_actions.map((item) => String(item).trim()).filter(Boolean).slice(0, 5)
      : [];

    if (
      !requirements.length
      && !listings.length
      && !followUps.length
      && !unresolvedQuestions.length
      && !recommendedActions.length
    ) {
      return fallback;
    }

    return {
      requirements,
      listings,
      follow_ups: followUps,
      unresolved_questions: unresolvedQuestions,
      recommended_actions: recommendedActions,
    };
  } catch {
    return fallback;
  }
}

export async function summarizeBrokerThreadWithLlm(input: {
  remoteJid: string;
  lines: string[];
}) {
  const fallback = fallbackSummary(input.lines);
  if (!input.lines.length) return fallback;

  const systemPrompt = [
    "You summarize Indian real estate broker WhatsApp threads for an operator.",
    "Return strict JSON with keys: summary, next_action, key_points.",
    "key_points must be an array of up to 5 concise bullets without numbering.",
    "Mention commitments, budget/location cues, availability cues, and the strongest next step.",
  ].join(" ");

  const userPrompt = [
    `Chat JID: ${input.remoteJid}`,
    "Summarize this broker thread:",
    input.lines.join("\n"),
  ].join("\n\n");

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];

  const openRouterKey = process.env.OPENROUTER_API_KEY || "";
  if (openRouterKey) {
    try {
      const raw = await callOpenAICompatible(
        OPENROUTER_BASE_URL,
        openRouterKey,
        OPENROUTER_MODEL,
        messages,
        {
          "HTTP-Referer": "https://mcp.propai.live",
          "X-Title": "PropAI MCP",
        },
      );
      return parseSummary(raw, fallback);
    } catch {
      // Fall through to the next provider.
    }
  }

  const groqKey = process.env.GROQ_API_KEY || "";
  if (groqKey) {
    try {
      const raw = await callOpenAICompatible(
        GROQ_BASE_URL,
        groqKey,
        GROQ_MODEL,
        messages,
      );
      return parseSummary(raw, fallback);
    } catch {
      // Fall through to the heuristic fallback.
    }
  }

  return fallback;
}

export async function extractThreadActionsWithLlm(input: {
  remoteJid: string;
  lines: string[];
}) {
  const fallback = fallbackThreadActions(input.lines);
  if (!input.lines.length) return fallback;

  const systemPrompt = [
    "You extract real-estate CRM actions from Indian broker WhatsApp threads.",
    "Return strict JSON with keys: requirements, listings, follow_ups, unresolved_questions, recommended_actions.",
    "Only include items strongly supported by the thread.",
    "Each requirement or listing must preserve a concise raw_text field from the thread in paraphrased form.",
    "follow_ups should capture who needs a callback and why.",
  ].join(" ");

  const userPrompt = [
    `Chat JID: ${input.remoteJid}`,
    "Extract broker workflow actions from this thread:",
    input.lines.join("\n"),
  ].join("\n\n");

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];

  const openRouterKey = process.env.OPENROUTER_API_KEY || "";
  if (openRouterKey) {
    try {
      const raw = await callOpenAICompatible(
        OPENROUTER_BASE_URL,
        openRouterKey,
        OPENROUTER_MODEL,
        messages,
        {
          "HTTP-Referer": "https://mcp.propai.live",
          "X-Title": "PropAI MCP",
        },
      );
      return parseThreadActions(raw, fallback);
    } catch {
      // Fall through.
    }
  }

  const groqKey = process.env.GROQ_API_KEY || "";
  if (groqKey) {
    try {
      const raw = await callOpenAICompatible(
        GROQ_BASE_URL,
        groqKey,
        GROQ_MODEL,
        messages,
      );
      return parseThreadActions(raw, fallback);
    } catch {
      // Fall through.
    }
  }

  return fallback;
}

function fallbackGrowthDraft(input: {
  assetType: string;
  audience: string;
  context: string;
}): GrowthDraft {
  return {
    title: `PropAI ${input.assetType} draft`,
    body: [
      `Audience: ${input.audience}`,
      input.context || "Use PropAI's broker-network data, CRM actions, and workflow automation as the core message.",
      "Focus on concrete broker outcomes: faster response, cleaner follow-ups, better matching, and easier pricing decisions.",
    ].join("\n\n"),
    CTA: "Reply if you want this rewritten for a specific broker, investor, or partner audience.",
    angle: "Operational proof over generic hype",
  };
}

function parseGrowthDraft(raw: string, fallback: GrowthDraft) {
  try {
    const parsed = JSON.parse(raw) as Partial<GrowthDraft>;
    const title = String(parsed.title || "").trim();
    const body = String(parsed.body || "").trim();
    const CTA = String(parsed.CTA || "").trim();
    const angle = String(parsed.angle || "").trim();
    if (!title || !body || !CTA || !angle) return fallback;
    return { title, body, CTA, angle };
  } catch {
    return fallback;
  }
}

export async function draftGrowthAssetWithLlm(input: {
  assetType: "launch_post" | "broker_pitch" | "partner_outreach" | "case_study";
  audience: string;
  context: string;
  tone?: string;
}) {
  const fallback = fallbackGrowthDraft(input);
  const systemPrompt = [
    "You write sharp GTM copy for PropAI, an Indian real estate workflow product for brokers.",
    "Return strict JSON with keys: title, body, CTA, angle.",
    "Write with concrete operator language, not startup fluff.",
    "Use proof, workflow outcomes, and clear differentiation.",
  ].join(" ");

  const userPrompt = [
    `Asset type: ${input.assetType}`,
    `Audience: ${input.audience}`,
    `Tone: ${input.tone || "clear, direct, operator-grade"}`,
    "Context:",
    input.context || "PropAI connects broker-network inventory, CRM actions, follow-ups, thread summaries, and pricing workflows through MCP and internal AI surfaces.",
  ].join("\n\n");

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];

  const openRouterKey = process.env.OPENROUTER_API_KEY || "";
  if (openRouterKey) {
    try {
      const raw = await callOpenAICompatible(
        OPENROUTER_BASE_URL,
        openRouterKey,
        OPENROUTER_MODEL,
        messages,
        {
          "HTTP-Referer": "https://mcp.propai.live",
          "X-Title": "PropAI MCP",
        },
      );
      return parseGrowthDraft(raw, fallback);
    } catch {
      // Fall through.
    }
  }

  const groqKey = process.env.GROQ_API_KEY || "";
  if (groqKey) {
    try {
      const raw = await callOpenAICompatible(
        GROQ_BASE_URL,
        groqKey,
        GROQ_MODEL,
        messages,
      );
      return parseGrowthDraft(raw, fallback);
    } catch {
      // Fall through.
    }
  }

  return fallback;
}
