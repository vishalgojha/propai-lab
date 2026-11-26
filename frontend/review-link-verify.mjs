import puppeteer from "puppeteer-core";

// Rendered verification that review entry points no longer target the retired
// /chat?tab=review: dashboard "Review Items" card href -> /inbox, and the
// /review-center route redirects to /inbox (checked separately via HTTP).
const APP = "http://localhost:3100";

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
  if (url.includes("/api/market/access")) { reply({ authenticated: true, whatsapp_connected: true, market_groups_confirmed: true, trial_active: true, paid_active: false, market_unlocked: true, trial_state: "active", trial_started_at: "2026-11-20T10:00:00Z", trial_ends_at: new Date(Date.now() + 11 * 86400000).toISOString(), trial_first_search: true }); return; }
  if (url.includes("/api/phones")) { reply({ phones: [] }); return; }
  if (url.includes("/api/dashboard/whatsapp-status")) { reply({ connected: false, state: "stopped", status_available: true, status_stale: false }); return; }
  reply({});
});

await page.goto(APP + "/dashboard", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForFunction(() => {
  const links = Array.from(document.querySelectorAll("a[href]"));
  return links.some((a) => a.getAttribute("href") === "/inbox") && document.body.innerHTML.includes("Review Items");
}, { timeout: 75000, polling: 1000 });

const state = await page.evaluate(() => {
  const hrefs = Array.from(document.querySelectorAll("a[href]")).map((a) => a.getAttribute("href"));
  const reviewAnchor = Array.from(document.querySelectorAll("a")).find((a) => (a.textContent || "").includes("Review Items"));
  return {
    reviewItemsHref: reviewAnchor ? reviewAnchor.getAttribute("href") : null,
    staleReviewLinks: hrefs.filter((h) => (h || "").includes("tab=review")).length,
    chatLinks: hrefs.filter((h) => (h || "").startsWith("/chat")),
  };
});
if (state.reviewItemsHref) {
  await page.evaluate(() => {
    const el = Array.from(document.querySelectorAll("a")).find((a) => (a.textContent || "").includes("Review Items"));
    if (el) el.scrollIntoView({ block: "center" });
  });
  await new Promise((r) => setTimeout(r, 800));
}
await page.screenshot({ path: "/tmp/review-link-dashboard.png" });
console.log("STATE:", JSON.stringify(state));
await browser.close();
