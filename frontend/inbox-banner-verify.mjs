import puppeteer from "puppeteer-core";

// Verifies the Inbox connect reminder: visible when /market/access reports
// WhatsApp disconnected, absent when connected. Modes: disconnected | connected
const APP = "http://localhost:3100";
const MODE = process.argv[2] || "disconnected";

const access = MODE === "connected"
  ? { authenticated: true, whatsapp_connected: true, market_groups_confirmed: true, trial_active: true, paid_active: false, market_unlocked: true, trial_state: "active", trial_started_at: "2026-11-20T10:00:00Z", trial_ends_at: null, trial_first_search: false }
  : { authenticated: true, whatsapp_connected: false, market_groups_confirmed: false, trial_active: false, paid_active: false, market_unlocked: false, trial_state: "not_started", trial_started_at: null, trial_ends_at: null, trial_first_search: null };

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
const seen = [];
page.on("console", (m) => { if (true) seen.push("CONSOLE:" + m.text().slice(0, 120)); });
page.on("requestfailed", (r) => seen.push("FAILED:" + r.url().slice(0, 100)));
await page.setRequestInterception(true);
page.on("request", (req) => {
  const url = req.url();
  if (url.includes("/api/")) seen.push(url.replace(APP, ""));
  if (url.includes(".supabase.co/auth/")) {
    req.respond({ status: 200, contentType: "application/json", body: JSON.stringify({ id: "visual-check-user", aud: "authenticated", role: "authenticated", email: "owner@example.com" }) });
    return;
  }
  if (!url.startsWith(APP + "/api/")) { req.continue(); return; }
  const reply = (body, status = 200) => req.respond({ status, contentType: "application/json", body: JSON.stringify(body) });
  if (url.includes("/api/market/access")) { reply(access); return; }
  if (url.includes("saved-searches")) { reply([]); return; }
  if (url.includes("/api/phones")) { reply({ phones: [] }); return; }
  if (url.includes("/api/dashboard/whatsapp-status")) { reply({ connected: false, state: "stopped", status_available: true, status_stale: false }); return; }
  reply({ items: [], total: 0 });
});

await page.goto(APP + "/inbox", { waitUntil: "domcontentloaded", timeout: 90000 });
await new Promise((r) => setTimeout(r, 10000));

const result = await page.evaluate(() => {
  const text = document.body.innerText.replace(/\s+/g, " ");
  return {
    banner: text.includes("Connect WhatsApp to get started"),
    stuck: text.includes("Loading session"),
  };
});
await page.screenshot({ path: `/tmp/inbox-banner-${MODE}.png` });
console.log(MODE, JSON.stringify(result));
console.log("API_REQS:", JSON.stringify(seen.slice(0, 25)));
await browser.close();

const pass = (MODE === "disconnected") === result.banner && !result.stuck;
console.log(pass ? "PASS" : "FAIL");
process.exit(pass ? 0 : 1);
