import puppeteer from "puppeteer-core";

// Rendered pixel verification for the shared connection-status model on the
// connections page (local dev server, full bundle).
// Modes:
//   mixed-last-known  stored row connected + live probe fails -> header + card
//                     must read "Last known connected" (amber), never healthy
//   definitive-offline stored row connected + probe reports stopped -> header
//                     "0 connected" (red), card "Disconnected"
//   loading           probe hangs -> header "Checking connection…", card "Checking…"
//   recovery          probe live-connected and matching -> header "1 connected" healthy
//   bounded-fail      probe fails + stored row not connected -> header
//                     "Connection status unavailable" (amber), card "Service unavailable"
const APP = "http://localhost:3100";
const MODE = process.argv[2] || "mixed-last-known";

const storedPhone = (connected) => ({
  id: 7, organization_id: "org-visual", phone_number: "+919820056180", instance_name: "visual",
  broker_id: "broker-visual", is_active: true, self_chat_enabled: false, extraction_status: "running",
  connected_at: "2026-11-20T10:00:00Z", created_at: "2026-11-20T10:00:00Z", connected,
});
const LIVE = { connected: true, phone: "+919820056180", profile: "Owner", instance: "visual", state: "open", connected_since: "2026-11-25T09:00:00Z", status_stale: false, status_available: true };
const OFFLINE = { connected: false, phone: null, state: "stopped", status_stale: false, status_available: true };
const statsBody = { total_messages: 1200, total_parsed: 321, total_listings: 200, total_requirements: 121, total_brokers: 5, total_buildings: 6, stats_available: true };
const progressBody = { total_raw_messages: 1200, processed: 1200, pending: 0, suppressed: 0, eligible_pending: 0, progress_pct: 100, recently_processed: 12, rate_window_hours: 1 };

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/google-chrome",
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--hide-scrollbars"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
await page.evaluateOnNewDocument(() => {
  const session = {
    access_token: "visual-check-token", refresh_token: "visual-check-refresh",
    token_type: "bearer", expires_in: 86400, expires_at: Math.floor(Date.now() / 1000) + 86400,
    user: { id: "visual-check-user", aud: "authenticated", role: "authenticated", email: "owner@example.com" },
  };
  window.localStorage.setItem("sb-jsoiuzfwohtfkctlkozw-auth-token", JSON.stringify(session));
});
await page.setRequestInterception(true);
page.on("request", (req) => {
  const url = req.url();
  if (url.includes(".supabase.co/auth/")) {
    req.respond({ status: 200, contentType: "application/json", body: JSON.stringify({ id: "visual-check-user", aud: "authenticated", role: "authenticated", email: "owner@example.com" }) });
    return;
  }
  if (!url.startsWith(APP + "/api/")) { req.continue(); return; }
  const reply = (body, status = 200) => req.respond({ status, contentType: "application/json", body: JSON.stringify(body) });
  if (url.includes("/api/dashboard/whatsapp-status")) {
    if (MODE === "mixed-last-known" || MODE === "bounded-fail") { req.respond({ status: 500, contentType: "application/json", body: "{}" }); return; }
    if (MODE === "definitive-offline") { reply(OFFLINE); return; }
    if (MODE === "recovery") { reply(LIVE); return; }
    if (MODE === "loading") { return; } // never settle
  }
  if (url.includes("/api/phones")) {
    reply({ phones: [storedPhone(MODE !== "bounded-fail")] }); return;
  }
  if (url.includes("/api/stats")) { reply(statsBody); return; }
  if (url.includes("/api/extraction/progress")) { reply(progressBody); return; }
  if (url.includes("/api/onboarding/groups")) { reply({ groups: [], selected_count: 0 }); return; }
  reply({});
});

await page.goto(APP + "/connections", { waitUntil: "domcontentloaded", timeout: 90000 });
await new Promise((r) => setTimeout(r, MODE === "loading" ? 6000 : 9000));

const state = await page.evaluate(() => {
  const text = document.body.innerText.replace(/\s+/g, " ");
  const grab = (re) => (text.match(re) || ["n/a"])[0];
  return {
    headerLine: grab(/(Checking connection…|Last known connected[^·]*· live status unavailable|Connection status unavailable|Reconnecting…|\d+ connected|0 connected)/),
    globalPill: grab(/(WhatsApp connected|WhatsApp disconnected|WhatsApp status unknown|Checking WhatsApp|Connect WhatsApp|Add WhatsApp number)/),
    capturePill: grab(/(Raw capture active|Raw capture disconnected|Raw capture unknown|Checking raw capture)/),
    sidebarCard: grab(/(WhatsApp Connected|WhatsApp Disconnected|WhatsApp status stale)/),
    pairingPanelShown: text.includes("Connect PropAI to WhatsApp"),
    reconnectCtaShown: Boolean(document.querySelector(".whatsapp-reconnect-action")),
    checkStatusShown: text.includes("Check status"),
  };
});
console.log("MODE:", MODE);
console.log("STATE:", JSON.stringify(state));
await page.screenshot({ path: `/tmp/conn-pixels-${MODE}.png`, fullPage: false });
await browser.close();
