import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

/*
 * All LLM calls route through the shared LiteLLM gateway.
 * litellm handles provider fallback (groq → gemini → nvidia → cerebras → doubleword).
 * www only needs two env vars:
 *   DOUBLEWORD_API_URL  → litellm external URL (e.g. http://<server>:4000)
 *   DOUBLEWORD_API_KEY  → LITELLM_MASTER_KEY
 */

const litellm = createOpenAICompatible({
  name: "litellm",
  baseURL: process.env.DOUBLEWORD_API_URL || "http://localhost:4000",
  apiKey: process.env.DOUBLEWORD_API_KEY || "no-key",
});

export const model = litellm.chatModel(
  process.env.DOUBLEWORD_MODEL || "chat",
);
