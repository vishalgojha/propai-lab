import puppeteer from "puppeteer-core";

// Verifies the setup-guide persistence rule: a permanent dismissal must NOT
// hide the guide while WhatsApp is disconnected, and must hide it again once
// connected. Modes: dismissed-disconnected | dismissed-connected
const APP = "http://localhost:3100";
const MODE = process.argv[2] || "dismissed-disconnected";

const disconnected = { authenticated: true, whatsapp_connected: false, market_groups_confirmed: false, trial_active: false, paid_active: false, market_unlocked: false, trial_state: "not_started", trial_started_at: null, trial_ends_at: null, trial_first_search: null };
const connected = { authenticated: true, whatsapp_connected: true, market_groups_confirmed: true, trial_active: true, paid_active: false, market_unlocked: true, trial_state: "active", trial_started_at: "2026-11-20T10:00:00Z", trial_ends_at: new Date(Date.now() + 11 * 86400000).toISOString(), trial_first_search: false };
const usableKey = { id: "k1", revoked_at: null, expires_at: null };

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
  // The user previously hid the guide permanently.
  window.localStorage.setItem("propai_setup_dismissed:visual-check-user", "1");
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
  if (url.includes("/api/market/access")) { reply(MODE === "dismissed-connected" ? connected : disconnected); return; }
  if (url.includes("/api/external/v1/keys")) { reply({ keys: MODE === "dismissed-connected" ? [usableKey] : [] }); return; }
  if (url.includes("/api/phones")) { reply({ phones: [] }); return; }
  if (url.includes("/api/dashboard/whatsapp-status")) { reply({ connected: false, state: "stopped", status_available: true, status_stale: false }); return; }
  reply({});
});

await page.goto(APP + "/setup", { waitUntil: "domcontentloaded", timeout: 90000 });
await new Promise((r) => setTimeout(r, 8000));

const result = await page.evaluate(() => {
  const text = document.body.innerText.replace(/\s+/g, " ");
  return {
    guideVisible: text.includes("Four steps to your first answer"),
    hidMessage: text.includes("You hid the setup guide"),
  };
});
await page.screenshot({ path: `/tmp/setup-persistence-${MODE}.png` });
console.log(MODE, JSON.stringify(result));
await browser.close();

const pass = MODE === "dismissed-disconnected"
  ? result.guideVisible && !result.hidMessage
  : !result.guideVisible && result.hidMessage;
console.log(pass ? "PASS" : "FAIL");
process.exit(pass ? 0 : 1);
