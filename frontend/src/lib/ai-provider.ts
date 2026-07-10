import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

const doubleword = createOpenAICompatible({
  name: "doubleword",
  baseURL: process.env.DOUBLEWORD_API_URL || "https://api.doubleword.ai/v1",
  apiKey: process.env.DOUBLEWORD_API_KEY,
});

export const model = doubleword.chat(
  process.env.DOUBLEWORD_MODEL || "Qwen/Qwen3.6-35B-A3B-FP8"
);