import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

const providers = [
  {
    name: "nvidia",
    baseURL: "https://integrate.api.nvidia.com/v1",
    model: process.env.NVIDIA_MODEL || "",
    key: process.env.NVIDIA_API_KEY,
  },
  {
    name: "nvidia-2",
    baseURL: "https://integrate.api.nvidia.com/v1",
    model: process.env.NVIDIA_MODEL || "",
    key: process.env.NVIDIA_API_KEY_2,
  },
  {
    name: "nvidia-3",
    baseURL: "https://integrate.api.nvidia.com/v1",
    model: process.env.NVIDIA_MODEL || "",
    key: process.env.NVIDIA_API_KEY_3,
  },
  {
    name: "groq",
    baseURL: "https://api.groq.com/openai/v1",
    model: process.env.GROQ_MODEL || "",
    key: process.env.GROQ_API_KEY,
  },
  {
    name: "gemini",
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
    model: process.env.GEMINI_MODEL || "",
    key: process.env.GEMINI_API_KEY,
  },
  {
    name: "cerebras",
    baseURL: "https://api.cerebras.ai/v1",
    model: process.env.CEREBRAS_MODEL || "",
    key: process.env.CEREBRAS_API_KEY,
  },
  {
    name: "doubleword",
    baseURL: process.env.DOUBLEWORD_API_URL || "https://api.doubleword.ai/v1",
    model: process.env.DOUBLEWORD_MODEL || "",
    key: process.env.DOUBLEWORD_API_KEY,
  },
];

function selectWorkingProvider() {
  for (const p of providers) {
    if (!p.key || !p.model) continue;
    return p;
  }
  return undefined;
}

export function getConfiguredModel() {
  const working = selectWorkingProvider();
  if (!working) return null;
  const client = createOpenAICompatible({ name: working.name, baseURL: working.baseURL, apiKey: working.key });
  return client.chatModel(working.model);
}
