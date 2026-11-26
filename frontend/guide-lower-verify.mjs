import puppeteer from "puppeteer-core";

// Captures the LOWER steps of the forced-visible setup guide at mobile width
// (the guide sits in an inner scroll container, so a plain fullPage shot
// clips steps 3-4).
const APP = "http://localhost:3100";
const disconnected = { authenticated: true, whatsapp_connected: false, market_groups_confirmed: false, trial_active: false, paid_active: false, market_unlocked: false, trial_state: "not_started", trial_started_at: null, trial_ends_at: null, trial_first_search: null };

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/google-chrome",
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--hide-scrollbars"],
});
const page = await browser.newPage();
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
await page.evaluateOnNewDocument(() => {
  const session = {
    access_token: "visual-check-token", refresh_token: "visual-check-refresh",
    token_type: "bearer", expires_in: 86400, expires_at: Math.floor(Date.now() / 1000) + 86400,
    user: { id: "visual-check-user", aud: "authenticated", role: "authenticated", email: "owner@example.com" },
  };
  window.localStorage.setItem("sb-jsoiuzfwohtfkctlkozw-auth-token", JSON.stringify(session));
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
  if (url.includes("/api/market/access")) { reply(disconnected); return; }
  if (url.includes("/api/external/v1/keys")) { reply({ keys: [] }); return; }
  if (url.includes("/api/phones")) { reply({ phones: [] }); return; }
  if (url.includes("/api/dashboard/whatsapp-status")) { reply({ connected: false, state: "stopped", status_available: true, status_stale: false }); return; }
  reply({});
});

await page.goto(APP + "/setup", { waitUntil: "domcontentloaded", timeout: 90000 });
await new Promise((r) => setTimeout(r, 8000));

// Scroll the guide's step 4 into view inside whatever container scrolls.
const found = await page.evaluate(() => {
  const nodes = Array.from(document.querySelectorAll("*"));
  const step4 = nodes.find((n) => n.children.length === 0 && /4\.\s*Ask|Ask your assistant|first question/i.test(n.textContent || ""));
  if (!step4) return { ok: false, hint: document.body.innerText.slice(0, 300) };
  step4.scrollIntoView({ block: "center", behavior: "instant" });
  return { ok: true, step: step4.textContent };
});
await new Promise((r) => setTimeout(r, 1200));
await page.screenshot({ path: "/tmp/friction-mobile-guide-lower.png" });
console.log(JSON.stringify(found));
const text = await page.evaluate(() => document.body.innerText.replace(/\s+/g, " "));
const lowerVisible = /Approve|assistant/i.test(text) && /search|question/i.test(text);
console.log(JSON.stringify({ lowerStepsInDom: lowerVisible }));
await browser.close();
process.exit(found.ok ? 0 : 1);
