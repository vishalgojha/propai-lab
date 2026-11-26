import puppeteer from "puppeteer-core";

// Rendered verification that review entry points no longer target the retired
// /chat?tab=review: the dashboard "Review Items" action card is a button that
// router.push()es to /inbox, and clicking it navigates there. The
// /review-center route redirect is checked separately over HTTP.
const APP = "http://localhost:3100";

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/google-chrome",
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--hide-scrollbars"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
await page.evaluateOnNewDocument(() => {
  window.EventSource = class { constructor() {} addEventListener() {} removeEventListener() {} close() {} };
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
  if (url.startsWith(APP + "/api/")) {
    const reply = (body) => req.respond({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    if (url.includes("/api/dashboard/time-window")) { reply({ window: "today", label: "Today", messages: 3, total_messages: 3, supply: 1, total_supply: 1, demand: 1, total_demand: 1, rentals: 0, total_rentals: 0, needs_review: 1, total_needs_review: 1, start_date: "2026-11-26", end_date: "2026-11-26" }); return; }
    if (url.includes("/api/dashboard/action")) { reply({ disconnected_groups: 0, pending_review_unresolved: 2, low_confidence_parses: 0, buildings_pending_approval: 0 }); return; }
    if (url.includes("/api/chat/suggestions")) { reply({ pending: 2 }); return; }
    if (url.includes("/api/dashboard/feed")) { reply({ items: [] }); return; }
    if (url.includes("/api/audit/insights")) { reply({ brokers: [], daily_flow: [], markets: [] }); return; }
    if (url.includes("/api/audit/groups")) { reply({ groups: [] }); return; }
    if (url.includes("/api/market/access")) { reply({ authenticated: true, whatsapp_connected: true, market_groups_confirmed: true, trial_active: true, paid_active: false, market_unlocked: true, trial_state: "active", trial_started_at: "2026-11-20T10:00:00Z", trial_ends_at: new Date(Date.now() + 11 * 86400000).toISOString(), trial_first_search: true }); return; }
    if (url.includes("/api/phones")) { reply({ phones: [] }); return; }
    if (url.includes("/api/dashboard/whatsapp-status")) { reply({ connected: true, state: "running", status_available: true, status_stale: false }); return; }
    reply({});
    return;
  }
  req.continue();
});

await page.goto(APP + "/dashboard", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForFunction(() => document.body.innerHTML.includes("Review Items"), { timeout: 60000, polling: 1000 });
await new Promise((r) => setTimeout(r, 1500));

const before = await page.evaluate(() => {
  const btn = Array.from(document.querySelectorAll("button.dashboard-action-card")).find((b) => (b.textContent || "").includes("Review Items"));
  if (!btn) return { found: false };
  btn.scrollIntoView({ block: "center" });
  return { found: true, label: (btn.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80) };
});
await new Promise((r) => setTimeout(r, 800));
await page.screenshot({ path: "/tmp/review-link-dashboard.png" });

let afterUrl = null;
if (before.found) {
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll("button.dashboard-action-card")).find((b) => (b.textContent || "").includes("Review Items"));
    btn.click();
  });
  await new Promise((r) => setTimeout(r, 4000));
  afterUrl = page.url();
}
console.log("STATE:", JSON.stringify({ before, afterUrl }));
await browser.close();
