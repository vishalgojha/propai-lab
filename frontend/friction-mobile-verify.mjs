import puppeteer from "puppeteer-core";

// Bounded acceptance checks for the onboarding-friction changes, mostly at
// mobile width (brokers' primary entry):
//   mobile-banner      /inbox disconnected at 390px: connect reminder visible
//   cta                banner CTAs navigate to /whatsapp?tab=numbers and /setup
//   mobile-guide       /setup dismissed+disconnected at 390px: guide forced visible (full page)
//   snooze             /setup disconnected: X hides for the session, next visit shows it again
//   mobile-connected   /setup dismissed+connected at 390px: stays dismissed
//   unknown-status     /setup dismissed + /market/access failing: no forced reminder
const APP = "http://localhost:3100";
const SCENARIO = process.argv[2] || "mobile-banner";

const disconnected = { authenticated: true, whatsapp_connected: false, market_groups_confirmed: false, trial_active: false, paid_active: false, market_unlocked: false, trial_state: "not_started", trial_started_at: null, trial_ends_at: null, trial_first_search: null };
const connected = { authenticated: true, whatsapp_connected: true, market_groups_confirmed: true, trial_active: true, paid_active: false, market_unlocked: true, trial_state: "active", trial_started_at: "2026-11-20T10:00:00Z", trial_ends_at: new Date(Date.now() + 11 * 86400000).toISOString(), trial_first_search: false };
const usableKey = { id: "k1", revoked_at: null, expires_at: null };

const isInbox = SCENARIO === "mobile-banner" || SCENARIO === "cta";
const accessMode = SCENARIO === "mobile-connected" ? "connected" : "disconnected";
const accessFails = SCENARIO === "unknown-status";
const preDismissed = ["mobile-guide", "mobile-connected", "unknown-status"].includes(SCENARIO);

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/google-chrome",
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--hide-scrollbars"],
});
const page = await browser.newPage();
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
await page.evaluateOnNewDocument((dismiss) => {
  const session = {
    access_token: "visual-check-token", refresh_token: "visual-check-refresh",
    token_type: "bearer", expires_in: 86400, expires_at: Math.floor(Date.now() / 1000) + 86400,
    user: { id: "visual-check-user", aud: "authenticated", role: "authenticated", email: "owner@example.com" },
  };
  window.localStorage.setItem("sb-jsoiuzfwohtfkctlkozw-auth-token", JSON.stringify(session));
  if (dismiss) window.localStorage.setItem("propai_setup_dismissed:visual-check-user", "1");
}, preDismissed);
await page.setRequestInterception(true);
page.on("request", (req) => {
  const url = req.url();
  if (url.includes(".supabase.co/auth/")) {
    req.respond({ status: 200, contentType: "application/json", body: JSON.stringify({ id: "visual-check-user", aud: "authenticated", role: "authenticated", email: "owner@example.com" }) });
    return;
  }
  if (!url.startsWith(APP + "/api/")) { req.continue(); return; }
  const reply = (body, status = 200) => req.respond({ status, contentType: "application/json", body: JSON.stringify(body) });
  if (url.includes("/api/market/access")) {
    if (accessFails) { reply({ error: "down" }, 500); return; }
    reply(accessMode === "connected" ? connected : disconnected); return;
  }
  if (url.includes("/api/external/v1/keys")) { reply({ keys: accessMode === "connected" ? [usableKey] : [] }); return; }
  if (url.includes("saved-searches")) { reply([]); return; }
  if (url.includes("/api/phones")) { reply({ phones: [] }); return; }
  if (url.includes("/api/dashboard/whatsapp-status")) { reply({ connected: false, state: "stopped", status_available: true, status_stale: false }); return; }
  reply(isInbox ? { items: [], total: 0 } : {});
});

const guideState = () => page.evaluate(() => {
  const text = document.body.innerText.replace(/\s+/g, " ");
  return {
    guideVisible: text.includes("Four steps to your first answer"),
    hidMessage: text.includes("You hid the setup guide"),
    banner: text.includes("Connect WhatsApp to get started"),
  };
});

let pass = false;
const out = { scenario: SCENARIO };

if (SCENARIO === "mobile-banner") {
  await page.goto(APP + "/inbox", { waitUntil: "domcontentloaded", timeout: 90000 });
  await new Promise((r) => setTimeout(r, 10000));
  const s = await guideState();
  await page.screenshot({ path: "/tmp/friction-mobile-banner.png", fullPage: true });
  Object.assign(out, s);
  pass = s.banner;
} else if (SCENARIO === "cta") {
  await page.goto(APP + "/inbox", { waitUntil: "domcontentloaded", timeout: 90000 });
  await new Promise((r) => setTimeout(r, 10000));
  const hrefs = await page.evaluate(() => Array.from(document.querySelectorAll("a")).filter((a) => /Connect WhatsApp|Open setup guide/.test(a.textContent || "")).map((a) => a.getAttribute("href")));
  out.hrefs = hrefs;
  await page.evaluate(() => Array.from(document.querySelectorAll("a")).find((a) => (a.textContent || "").trim() === "Connect WhatsApp")?.click());
  await new Promise((r) => setTimeout(r, 2500));
  out.afterConnectClick = new URL(page.url()).pathname + new URL(page.url()).search;
  await page.goto(APP + "/inbox", { waitUntil: "domcontentloaded", timeout: 90000 });
  await new Promise((r) => setTimeout(r, 9000));
  await page.evaluate(() => Array.from(document.querySelectorAll("a")).find((a) => (a.textContent || "").trim() === "Open setup guide")?.click());
  await new Promise((r) => setTimeout(r, 2500));
  out.afterSetupClick = new URL(page.url()).pathname;
  pass = hrefs.includes("/whatsapp?tab=numbers") && hrefs.includes("/setup")
    && out.afterConnectClick === "/whatsapp?tab=numbers" && out.afterSetupClick === "/setup";
} else if (SCENARIO === "mobile-guide") {
  await page.goto(APP + "/setup", { waitUntil: "domcontentloaded", timeout: 90000 });
  await new Promise((r) => setTimeout(r, 8000));
  const s = await guideState();
  await page.screenshot({ path: "/tmp/friction-mobile-guide.png", fullPage: true });
  Object.assign(out, s);
  pass = s.guideVisible && !s.hidMessage;
} else if (SCENARIO === "snooze") {
  await page.goto(APP + "/setup", { waitUntil: "domcontentloaded", timeout: 90000 });
  await new Promise((r) => setTimeout(r, 8000));
  out.beforeSnooze = await guideState();
  await page.click('button[aria-label="Hide setup guide"]');
  await new Promise((r) => setTimeout(r, 1200));
  out.afterSnooze = await guideState();
  await page.reload({ waitUntil: "domcontentloaded" });
  await new Promise((r) => setTimeout(r, 8000));
  out.nextVisit = await guideState();
  await page.screenshot({ path: "/tmp/friction-mobile-snooze-next-visit.png", fullPage: true });
  pass = out.beforeSnooze.guideVisible && !out.afterSnooze.guideVisible && out.nextVisit.guideVisible;
} else if (SCENARIO === "mobile-connected") {
  await page.goto(APP + "/setup", { waitUntil: "domcontentloaded", timeout: 90000 });
  await new Promise((r) => setTimeout(r, 8000));
  const s = await guideState();
  await page.screenshot({ path: "/tmp/friction-mobile-connected.png", fullPage: true });
  Object.assign(out, s);
  pass = !s.guideVisible && s.hidMessage;
} else if (SCENARIO === "unknown-status") {
  await page.goto(APP + "/setup", { waitUntil: "domcontentloaded", timeout: 90000 });
  await new Promise((r) => setTimeout(r, 8000));
  const s = await guideState();
  await page.screenshot({ path: "/tmp/friction-mobile-unknown-status.png", fullPage: true });
  Object.assign(out, s);
  pass = !s.guideVisible && s.hidMessage;
}

console.log(JSON.stringify(out));
console.log(pass ? "PASS" : "FAIL");
await browser.close();
process.exit(pass ? 0 : 1);
