import puppeteer from "puppeteer-core";
const APP = "http://localhost:3100";
const disconnected = { authenticated: true, whatsapp_connected: false, market_groups_confirmed: false, trial_active: false, paid_active: false, market_unlocked: false, trial_state: "not_started", trial_started_at: null, trial_ends_at: null, trial_first_search: null };
const browser = await puppeteer.launch({ executablePath: "/usr/bin/google-chrome", headless: "new", args: ["--no-sandbox", "--disable-dev-shm-usage", "--hide-scrollbars"] });
const page = await browser.newPage();
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
await page.evaluateOnNewDocument(() => {
  const session = { access_token: "t", refresh_token: "r", token_type: "bearer", expires_in: 86400, expires_at: Math.floor(Date.now() / 1000) + 86400, user: { id: "visual-check-user", aud: "authenticated", role: "authenticated", email: "owner@example.com" } };
  window.localStorage.setItem("sb-jsoiuzfwohtfkctlkozw-auth-token", JSON.stringify(session));
});
await page.setRequestInterception(true);
page.on("request", (req) => {
  const url = req.url();
  if (url.includes(".supabase.co/auth/")) { req.respond({ status: 200, contentType: "application/json", body: JSON.stringify({ id: "visual-check-user", aud: "authenticated", role: "authenticated", email: "owner@example.com" }) }); return; }
  if (!url.startsWith(APP + "/api/")) { req.continue(); return; }
  const reply = (body, status = 200) => req.respond({ status, contentType: "application/json", body: JSON.stringify(body) });
  if (url.includes("/api/market/access")) { reply(disconnected); return; }
  if (url.includes("/phone-directory")) { reply({ entries: [], cap: 3, used: 0 }); return; }
  if (url.includes("/api/phones")) { reply({ phones: [] }); return; }
  if (url.includes("/api/onboarding/groups")) { reply({ groups: [], confirmation: null }); return; }
  if (url.includes("/api/orgs/current")) { reply({ id: "o1", name: "Fixture Org" }); return; }
  reply({});
});
await page.goto(APP + "/whatsapp?tab=numbers", { waitUntil: "domcontentloaded", timeout: 90000 });
await new Promise((r) => setTimeout(r, 10000));
const dom = await page.evaluate(() => {
  const card = document.querySelector(".whatsapp-directory-card");
  const btn = Array.from(document.querySelectorAll("button")).find((b) => (b.textContent || "").trim() === "Add number");
  const cardText = card ? card.innerText.replace(/\s+/g, " ").slice(0, 300) : null;
  if (card) card.scrollIntoView({ block: "top", behavior: "instant" });
  const hint = document.querySelector(".mb-8.rounded-xl.border");
  const openMyNumbers = Array.from(document.querySelectorAll("button")).find((b) => (b.textContent || "").trim() === "Open My Numbers");
  return { hasCard: !!card, cardText, addBtnVisible: !!btn && !btn.disabled, openMyNumbersPresent: !!openMyNumbers, hintText: hint ? hint.innerText.replace(/\s+/g, " ").slice(0, 220) : null };
});
await new Promise((r) => setTimeout(r, 1200));
await page.screenshot({ path: "/tmp/connect-first-run-directory.png" });
console.log(JSON.stringify(dom, null, 1));
await browser.close();
