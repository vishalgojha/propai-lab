import { tool } from "ai";
import { z } from "zod";

export const getOverviewTool = tool({
  description: "Get an overview of all available datasets (schema, row counts, sample values)",
  parameters: z.object({}),
  execute: async () => {
    const { supabaseAdmin } = await import("@/lib/supabase-admin");

    const sources = [
      "raw_messages",
      "parsed_observations",
      "listings",
      "brokers",
      "buildings",
      "groups",
      "senders",
    ];

    const overview: Record<string, any> = {};

    for (const source of sources) {
      try {
        const { count, error: countError } = await supabaseAdmin
          .from(source)
          .select("*", { count: "exact", head: true });

        if (countError) {
          overview[source] = { error: countError.message };
          continue;
        }

        const { data: sample, error: sampleError } = await supabaseAdmin
          .from(source)
          .select("*")
          .limit(3);

        if (sampleError) {
          overview[source] = { error: sampleError.message };
          continue;
        }

        overview[source] = {
          rowCount: count ?? 0,
          sample: sample || [],
          columns: sample && sample.length > 0 ? Object.keys(sample[0]) : [],
        };
      } catch (err: any) {
        overview[source] = { error: err.message };
      }
    }

    return overview;
  },
});
