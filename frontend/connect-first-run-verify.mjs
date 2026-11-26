import puppeteer from "puppeteer-core";

// Renders /whatsapp?tab=numbers for a fresh signed-up broker (no phone, no
// groups) at mobile width: is the pairing path obvious from the empty state?
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
});
const errors = [];
page.on("pageerror", (e) => errors.push("PAGEERR:" + String(e).slice(0, 140)));
page.on("console", (m) => { if (m.type() === "error") errors.push("CONSOLE:" + m.text().slice(0, 140)); });
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
  if (url.includes("/api/phones/directory")) { reply({ entries: [] }); return; }
  if (url.includes("/api/phones")) { reply({ phones: [] }); return; }
  if (url.includes("/api/onboarding/groups")) { reply({ groups: [], confirmation: null }); return; }
  if (url.includes("/api/org")) { reply({ org: { id: "o1", name: "Fixture Org" } }); return; }
  if (url.includes("/api/market/raw-sources")) { reply({ sources: [] }); return; }
  reply({});
});

await page.goto(APP + "/whatsapp?tab=numbers", { waitUntil: "domcontentloaded", timeout: 90000 });
await new Promise((r) => setTimeout(r, 10000));
const state = await page.evaluate(() => {
  const text = document.body.innerText.replace(/\s+/g, " ");
  const buttons = Array.from(document.querySelectorAll("button, a")).map((b) => (b.textContent || "").trim()).filter((t) => t && t.length < 60);
  return {
    hasAddNumber: /add (a )?(whatsapp )?number|connect (your )?whatsapp|link (a )?number/i.test(text),
    mentionsQR: /QR/i.test(text),
    mentionsPairCode: /linking code|pair(ing)? code|code/i.test(text),
    headline: text.slice(0, 400),
    buttons: buttons.slice(0, 25),
  };
});
await page.screenshot({ path: "/tmp/connect-first-run.png", fullPage: true });
console.log(JSON.stringify(state, null, 1));
console.log("ERRORS:", JSON.stringify(errors.slice(0, 8)));
await browser.close();
