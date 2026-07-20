import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

const providers = [
  {
    name: "nvidia",
    baseURL: "https://integrate.api.nvidia.com/v1",
    model: "nvidia/nemotron-3-ultra-550b-a55b",
    key: process.env.NVIDIA_API_KEY,
  },
  {
    name: "nvidia-2",
    baseURL: "https://integrate.api.nvidia.com/v1",
    model: "nvidia/nemotron-3-ultra-550b-a55b",
    key: process.env.NVIDIA_API_KEY_2,
  },
  {
    name: "nvidia-3",
    baseURL: "https://integrate.api.nvidia.com/v1",
    model: "nvidia/nemotron-3-ultra-550b-a55b",
    key: process.env.NVIDIA_API_KEY_3,
  },
  {
    name: "groq",
    baseURL: "https://api.groq.com/openai/v1",
    model: "llama-3.3-70b-versatile",
    key: process.env.GROQ_API_KEY,
  },
  {
    name: "gemini",
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
    model: "gemini-2.0-flash",
    key: process.env.GEMINI_API_KEY,
  },
  {
    name: "cerebras",
    baseURL: "https://api.cerebras.ai/v1",
    model: "llama-3.3-70b",
    key: process.env.CEREBRAS_API_KEY,
  },
  {
    name: "doubleword",
    baseURL: process.env.DOUBLEWORD_API_URL || "https://api.doubleword.ai/v1",
    model: process.env.DOUBLEWORD_MODEL || "Qwen/Qwen3.6-35B-A3B-FP8",
    key: process.env.DOUBLEWORD_API_KEY,
  },
];

function selectWorkingProvider() {
  for (const p of providers) {
    if (!p.key) continue;
    return p;
  }
  return providers[providers.length - 1];
}

const working = selectWorkingProvider();
const client = createOpenAICompatible({
  name: working.name,
  baseURL: working.baseURL,
  apiKey: working.key,
});

export const model = client.chatModel(working.model);
