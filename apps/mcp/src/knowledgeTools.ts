/**
 * Public building-knowledge tool.
 *
 * Reads the public, source-labelled building docs that the API serves at
 * /api/external/v1/knowledge/buildings. No account, no tenant data, read-only.
 * The docs are public background facts with marketing claims labelled; a
 * missing amenity section means nothing is recorded, not that none exist.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const KNOWLEDGE_API_BASE = (process.env.PROPAI_API_URL || "https://api.propai.live").replace(/\/$/, "");
const SLUG = /^[a-z0-9][a-z0-9-]{0,80}$/;

export function knowledgeUrl(slug?: string): string | null {
  const base = `${KNOWLEDGE_API_BASE}/api/external/v1/knowledge/buildings`;
  if (!slug) return base;
  return SLUG.test(slug) ? `${base}/${slug}` : null;
}

export function registerKnowledgeTool(server: McpServer): void {
  server.registerTool(
    "building_knowledge",
    {
      description:
        "Read PropAI's public Mumbai building knowledge docs (identity, look-alikes, developer-stated amenities with source URLs). Call with no slug to get the index of buildings, then call again with a slug from the index. Public background facts only, no broker or client data. Amenities are developer marketing claims; a missing amenity section means nothing is recorded, not that the building has none.",
      inputSchema: {
        slug: z.string().optional().describe("Building slug from the index, e.g. 'rustomjee-erika'. Omit to list all buildings."),
      },
    },
    async (input) => {
      const url = knowledgeUrl(input.slug);
      if (!url) {
        return { isError: true, content: [{ type: "text" as const, text: "Invalid slug. Call without a slug to see the index." }] };
      }
      try {
        const res = await fetch(url, { headers: { Accept: "text/plain" } });
        const text = await res.text();
        if (!res.ok) {
          return { isError: true, content: [{ type: "text" as const, text: `No knowledge document found (HTTP ${res.status}).` }] };
        }
        return { content: [{ type: "text" as const, text }] };
      } catch {
        return { isError: true, content: [{ type: "text" as const, text: "Building knowledge is temporarily unavailable." }] };
      }
    },
  );
}
