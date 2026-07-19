import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

/* ── Provider priority: NVIDIA first, then free providers, Doubleword (paid) last ── */

interface ProviderCfg {
  name: string;
  baseURL: string;
  apiKey: string;
  model: string;
}

function buildProviders(): ProviderCfg[] {
  const chain: ProviderCfg[] = [];

  if (process.env.NVIDIA_API_KEY) {
    chain.push({
      name: "nvidia-nim",
      baseURL: "https://integrate.api.nvidia.com/v1",
      apiKey: process.env.NVIDIA_API_KEY,
      model: "nvidia/nemotron-3-ultra-550b-a55b",
    });
  }

  if (process.env.GROQ_API_KEY) {
    chain.push({
      name: "groq",
      baseURL: "https://api.groq.com/openai/v1",
      apiKey: process.env.GROQ_API_KEY,
      model: "llama-3.3-70b-versatile",
    });
  }

  if (process.env.GEMINI_API_KEY) {
    chain.push({
      name: "gemini",
      baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
      apiKey: process.env.GEMINI_API_KEY,
      model: "gemini-2.0-flash",
    });
  }

  if (process.env.CEREBRAS_API_KEY) {
    chain.push({
      name: "cerebras",
      baseURL: "https://api.cerebras.ai/v1",
      apiKey: process.env.CEREBRAS_API_KEY,
      model: "llama-3.3-70b",
    });
  }

  // Doubleword — paid, always last
  if (process.env.DOUBLEWORD_API_KEY) {
    chain.push({
      name: "doubleword",
      baseURL: process.env.DOUBLEWORD_API_URL || "https://api.doubleword.ai/v1",
      apiKey: process.env.DOUBLEWORD_API_KEY,
      model: process.env.DOUBLEWORD_MODEL || "Qwen/Qwen3.6-35B-A3B-FP8",
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
