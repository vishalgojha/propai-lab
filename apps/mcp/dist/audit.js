import { supabase } from "./supabase.js";
// Import all the functions we need to test
// We'll import from the index.ts which re-exports everything
import * as mcp from "./index.js";
async function main() {
    console.log("=== Starting MCP Tools Audit ===\n");
    // Get a test broker ID
    let TEST_BROKER_ID = "";
    try {
        const { data: members, error } = await supabase
            .from("workspace_members")
            .select("workspace_owner_id")
            .eq("status", "active")
            .limit(1);
        if (error) {
            console.error("Error fetching active members:", error);
            // Fallback to first profile
            const { data: profiles, error: profileError } = await supabase
                .from("profiles")
                .select("id")
                .limit(1);
            if (profileError) {
                console.error("Error fetching profiles:", profileError);
                // Last resort: use a placeholder (but this will likely fail)
                TEST_BROKER_ID = "00000000-0000-0000-0000-000000000000";
            }
            else if (profiles && profiles.length > 0) {
                TEST_BROKER_ID = profiles[0].id;
            }
        }
        else {
            if (members && members.length > 0) {
                TEST_BROKER_ID = members[0].workspace_owner_id;
            }
            else {
                // No active members, try to get any profile
                const { data: profiles, error: profileError } = await supabase
                    .from("profiles")
                    .select("id")
                    .limit(1);
                if (profileError) {
                    console.error("Error fetching profiles:", profileError);
                    TEST_BROKER_ID = "00000000-0000-0000-0000-000000000000";
                }
                else if (profiles && profiles.length > 0) {
                    TEST_BROKER_ID = profiles[0].id;
                }
            }
        }
    }
    catch (err) {
        console.error("Unexpected error getting test broker ID:", err);
        TEST_BROKER_ID = "00000000-0000-0000-0000-000000000000";
    }
    console.log("Using test broker ID:", TEST_BROKER_ID);
    console.log("");
    // Helper to safely call functions and log results
    async function testFn(name, fn) {
        try {
            const result = await fn();
            // If result is an array, show length and first item snippet
            if (Array.isArray(result)) {
                if (result.length > 0) {
                    const firstItem = result[0];
                    let preview = "N/A";
                    if (firstItem !== null && typeof firstItem === 'object') {
                        preview = JSON.stringify(firstItem).substring(0, 120);
                        if (JSON.stringify(firstItem).length > 120)
                            preview += "...";
                    }
                    else if (firstItem !== null) {
                        preview = String(firstItem);
                    }
                    console.log(name + ": " + result.length + " rows", "sample: " + preview);
                }
                else {
                    console.log(name + ": " + result.length + " rows (EMPTY)");
                }
            }
            else if (result && typeof result === 'object') {
                // For objects, show a preview of selected fields or just say it's an object
                const keys = Object.keys(result);
                if (keys.length === 0) {
                    console.log(name + ": {}", "");
                }
                else {
                    // Try to show a meaningful preview
                    const previewObj = {};
                    const previewKeys = ['listing_count', 'avg_price_cr', 'summary', 'leads_total', 'messages_total', 'locality_supply'];
                    let hasPreview = false;
                    for (let i = 0; i < previewKeys.length; i++) {
                        const key = previewKeys[i];
                        if (result[key] !== undefined) {
                            previewObj[key] = result[key];
                            hasPreview = true;
                        }
                    }
                    if (hasPreview) {
                        const previewStr = JSON.stringify(previewObj);
                        console.log(name + ":", previewStr.length > 150 ? previewStr.substring(0, 150) + "..." : previewStr);
                    }
                    else {
                        console.log(name + ": object with keys [" + keys.join(', ') + "]");
                    }
                }
            }
            else {
                console.log(name + ":", result);
            }
        }
        catch (error) {
            console.error(name + ": ERROR -", error.message || error);
        }
    }
    // Group 0: New primary tools
    console.log("--- Group 0: New primary tools ---");
    await testFn("smartSearch_query_sale", async function () {
        const r = await mcp.executeSmartSearch({ query: "3 BHK for sale in Bandra under 8 crore", limit: 3 });
        return { intent: r.intent, count: r.totalResults, explanation: r.explanation, suggestions: r.suggestedFollowUps };
    });
    await testFn("smartSearch_requirements", async function () {
        const r = await mcp.executeSmartSearch({ query: "buyers looking for 2BHK in Khar West", limit: 3 });
        return { intent: r.intent, count: r.totalResults, explanation: r.explanation };
    });
    await testFn("smartSearch_market", async function () {
        const r = await mcp.executeSmartSearch({ query: "What is the market trend in Bandra?", limit: 3 });
        return { intent: r.intent, count: r.totalResults, explanation: r.explanation };
    });
    await testFn("smartSearch_brokers", async function () {
        const r = await mcp.executeSmartSearch({ query: "brokers dealing in Powai", limit: 3 });
        return { intent: r.intent, count: r.totalResults, explanation: r.explanation };
    });
    await testFn("getListing", async function () {
        const listing = await mcp.getListingById("test");
        return { found: listing !== null };
    });
    await testFn("searchBrokers", async function () {
        const brokers = await mcp.searchBrokers({ locality: "Bandra", limit: 3 });
        return { count: brokers.length };
    });
    console.log("");
    // Group 1: Public listing search (most critical)
    console.log("--- Group 1: Public listing search ---");
    await testFn("search_listings", function () { return mcp.searchPublicListings({}); });
    await testFn("search_listings sale", function () { return mcp.searchPublicListings({ locality: "Bandra", property_type: "sale", limit: 3, listingKind: "listing" }); });
    await testFn("search_listings rent", function () { return mcp.searchPublicListings({ locality: "Andheri", property_type: "rent", limit: 3, listingKind: "listing" }); });
    await testFn("search_listings all", function () { return mcp.searchPublicListings({ limit: 5 }); });
    await testFn("search_requirements", function () { return mcp.searchPublicListings({ locality: "Bandra", listingKind: "requirement", limit: 3 }); });
    await testFn("get_fresh_stream", function () { return mcp.getFreshStream({ hours: 24, limit: 5 }); });
    console.log("");
    // Group 2: Market intelligence
    console.log("--- Group 2: Market intelligence ---");
    await testFn("market_summary", function () { return mcp.getMarketSummary({ locality: "Bandra", days: 30, limit: 50 }); });
    await testFn("building_intel", function () { return mcp.getBuildingIntel({ building_name: "Kalpataru", days_back: 90 }); });
    await testFn("price_estimate", function () { return mcp.estimatePrice({ locality: "Bandra", bhk: 2, property_type: "sale" }); });
    await testFn("pricing_negotiation_brief", function () { return mcp.buildPricingNegotiationBrief({ locality: "Bandra", bhk: 2, asking_price_cr: 3.5 }); });
    console.log("");
    // Group 3: Broker workspace (requires brokerId)
    console.log("--- Group 3: Broker workspace ---");
    await testFn("broker_activity", function () { return mcp.getBrokerActivity({ brokerId: TEST_BROKER_ID, days: 7 }); });
    await testFn("triage_hot_leads", function () { return mcp.getHotLeadTriage({ brokerId: TEST_BROKER_ID, days: 7, limit: 5 }); });
    await testFn("stale_lead_reactivation", function () { return mcp.getStaleLeadReactivation({ brokerId: TEST_BROKER_ID, days_stale: 14, limit: 5 }); });
    await testFn("buyer_to_inventory_match", function () {
        return mcp.matchBuyerToInventory({
            brokerId: TEST_BROKER_ID,
            locality: "Bandra",
            bhk: 2,
            max_budget_cr: 4,
            source_mode: "both",
            limit: 5,
        });
    });
    await testFn("qualify_lead", function () {
        return mcp.qualifyLead({
            brokerId: TEST_BROKER_ID,
            raw_text: "2BHK Bandra budget 3Cr urgent",
            name: "Test Lead",
            phone: "9999999999",
            location_pref: "Bandra",
            budget: "3Cr",
            timeline: "1 month",
        });
    });
    await testFn("save_listing", function () {
        return mcp.saveListingRecord({
            brokerId: TEST_BROKER_ID,
            raw_text: "AUDIT TEST — 2BHK Bandra West 2.5Cr — delete after audit",
            location: "Bandra West",
            bhk: "2",
            price: "2.5Cr",
        });
    });
    await testFn("create_requirement", function () {
        return mcp.createRequirementRecord({
            brokerId: TEST_BROKER_ID,
            raw_text: "AUDIT TEST — need 2BHK Khar West under 2Cr — delete after audit",
            name: "Test Buyer",
            phone: "9888888888",
            location_pref: "Khar West",
            budget: "2Cr",
        });
    });
    await testFn("set_follow_up", function () {
        return mcp.scheduleFollowUp({
            brokerId: TEST_BROKER_ID,
            lead_name: "Audit Test Lead",
            lead_phone: "9777777777",
            action_type: "call",
            notes: "AUDIT TEST — delete after audit",
        });
    });
    console.log("");
    // Group 4: Thread tools (may be empty — log honestly)
    console.log("--- Group 4: Thread tools ---");
    // Get a real JID from messages table first
    let TEST_JID = "";
    try {
        const { data: msgRow, error: msgError } = await supabase
            .from("messages")
            .select("remote_jid")
            .eq("tenant_id", TEST_BROKER_ID)
            .limit(1)
            .single();
        if (msgError) {
            console.error("Error fetching test JID:", msgError);
            // Try without single() to see if we get any rows
            const { data: msgRows, error: multiError } = await supabase
                .from("messages")
                .select("remote_jid")
                .eq("tenant_id", TEST_BROKER_ID)
                .limit(1);
            if (multiError) {
                console.error("Error fetching multiple JIDs:", multiError);
            }
            else if (msgRows && msgRows.length > 0) {
                TEST_JID = msgRows[0].remote_jid;
            }
        }
        else if (msgRow) {
            TEST_JID = msgRow.remote_jid;
        }
    }
    catch (jidErr) {
        console.error("Unexpected error getting test JID:", jidErr);
    }
    console.log("Test JID:", TEST_JID || "NONE FOUND");
    if (TEST_JID) {
        await testFn("summarise_thread", function () { return mcp.summarizeThread({ brokerId: TEST_BROKER_ID, remote_jid: TEST_JID, limit: 20 }); });
        await testFn("extract_thread_actions", async function () {
            const threadSummary = await mcp.summarizeThread({ brokerId: TEST_BROKER_ID, remote_jid: TEST_JID, limit: 20 });
            const lines = threadSummary.key_points.map((kp) => `${kp.sender}: ${kp.text}`);
            if (lines.length === 0)
                return { action_count: 0, status: "no messages to process" };
            try {
                const aiModule = await import("./ai.js");
                const actions = await aiModule.extractThreadActionsWithLlm({ remoteJid: TEST_JID, lines });
                return { action_count: Object.keys(actions).length, ...actions };
            }
            catch (e) {
                return { action_count: 0, error: e.message || "LLM call failed", key_points_available: lines.length };
            }
        });
    }
    else {
        console.log("summarise_thread: SKIPPED — no messages found for broker");
        console.log("extract_thread_actions: SKIPPED — no messages found for broker");
    }
    console.log("");
    // Group 5: AI-dependent tools (log if LLM call fails)
    console.log("--- Group 5: AI-dependent tools ---");
    // 21. draft_broadcast (no LLM, pure format)
    try {
        const dataModule = await import("./data.js");
        const broadcast = dataModule.buildBroadcastDraft({
            location: "Bandra West",
            bhk: "2",
            price: "2.5Cr",
            contact_name: "Vishal",
            contact_number: "9999999999",
        });
        console.log("draft_broadcast:", broadcast.length > 10 ? "OK (" + broadcast.length + " chars)" : "EMPTY");
    }
    catch (e) {
        console.log("draft_broadcast: ERROR —", e.message || e);
    }
    // 22. draft_growth_asset (LLM call)
    try {
        const aiModule = await import("./ai.js");
        const asset = await aiModule.draftGrowthAssetWithLlm({
            assetType: "launch_post",
            audience: "Mumbai brokers",
            context: "PropAI parses WhatsApp groups into live listings",
        });
        console.log("draft_growth_asset:", asset.title ? "OK title=" + asset.title.substring(0, 50) : "FAILED");
    }
    catch (e) {
        console.log("draft_growth_asset: ERROR —", e instanceof Error ? e.message : e);
    }
    // 23. semantic_search (embedding call)
    try {
        const embeddingModule = await import("./embedding.js");
        const emb = await embeddingModule.generateEmbedding("2BHK Bandra sea view");
        console.log("semantic_search (embedding):", emb ? "OK length=" + emb.length : "FAILED — null embedding");
    }
    catch (e) {
        console.log("semantic_search (embedding): ERROR —", e instanceof Error ? e.message : e);
    }
    console.log("");
    // Group 6: Remaining tools — code path check
    console.log("--- Group 6: Remaining tools ---");
    // 24. save_thread_listing — same as save_listing, different entry point
    await testFn("save_thread_listing", function () {
        return mcp.saveListingRecord({
            brokerId: TEST_BROKER_ID,
            raw_text: "AUDIT TEST thread listing — delete after audit",
            location: "Juhu",
        });
    });
    // 25. save_thread_requirement — same as create_requirement
    await testFn("save_thread_requirement", function () {
        return mcp.createRequirementRecord({
            brokerId: TEST_BROKER_ID,
            raw_text: "AUDIT TEST thread requirement — delete after audit",
            name: "Thread Test",
        });
    });
    // 26. create_thread_follow_up — same as set_follow_up
    await testFn("create_thread_follow_up", function () {
        return mcp.scheduleFollowUp({
            brokerId: TEST_BROKER_ID,
            lead_name: "Thread FU Test",
            action_type: "call",
            notes: "AUDIT TEST — delete after audit",
        });
    });
    console.log("");
    console.log("=== Audit Complete ===");
}
// Run the audit
main().catch((err) => {
    console.error("Audit failed:", err);
    process.exit(1);
});
