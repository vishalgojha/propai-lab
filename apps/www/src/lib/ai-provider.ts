import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

/* ── Provider priority: NVIDIA×3 first, then free providers, Doubleword last ─── */

interface ProviderCfg {
  name: string;
  baseURL: string;
  apiKey: string;
  model: string;
}

const NVIDIA_BASE = "https://integrate.api.nvidia.com/v1";
const NVIDIA_MODEL = process.env.NVIDIA_MODEL || "";

function buildProviders(): ProviderCfg[] {
  const chain: ProviderCfg[] = [];

  const nvidiaKeys = [
    process.env.NVIDIA_API_KEY,
    process.env.NVIDIA_API_KEY_2,
    process.env.NVIDIA_API_KEY_3,
  ].filter(Boolean) as string[];

  nvidiaKeys.forEach((key, i) => {
    chain.push({
      name: `nvidia-nim-${i + 1}`,
      baseURL: NVIDIA_BASE,
      apiKey: key,
      model: NVIDIA_MODEL,
    });
  });

  if (process.env.GROQ_API_KEY && process.env.GROQ_MODEL) {
    chain.push({
      name: "groq",
      baseURL: "https://api.groq.com/openai/v1",
      apiKey: process.env.GROQ_API_KEY,
      model: process.env.GROQ_MODEL,
    });
  }

  if (process.env.GEMINI_API_KEY && process.env.GEMINI_MODEL) {
    chain.push({
      name: "gemini",
      baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
      apiKey: process.env.GEMINI_API_KEY,
      model: process.env.GEMINI_MODEL,
    });
  }

  if (process.env.CEREBRAS_API_KEY && process.env.CEREBRAS_MODEL) {
    chain.push({
      name: "cerebras",
      baseURL: "https://api.cerebras.ai/v1",
      apiKey: process.env.CEREBRAS_API_KEY,
      model: process.env.CEREBRAS_MODEL,
    });
  }

  // Doubleword — paid, always last
  if (process.env.DOUBLEWORD_API_KEY && process.env.DOUBLEWORD_MODEL) {
    chain.push({
      name: "doubleword",
      baseURL: process.env.DOUBLEWORD_API_URL || "https://api.doubleword.ai/v1",
      apiKey: process.env.DOUBLEWORD_API_KEY,
      model: process.env.DOUBLEWORD_MODEL,
    });
  }

  return chain;
}

export const providers = buildProviders();
export const providerCount = providers.length;

export function getProviderModel(index: number) {
  const cfg = providers[index];
  if (!cfg) return null;
  const client = createOpenAICompatible({
    name: cfg.name,
    baseURL: cfg.baseURL,
    apiKey: cfg.apiKey,
  });
  return { client, model: client.chatModel(cfg.model), name: cfg.name };
}
