import puppeteer from "puppeteer-core";

// Verifies the PWA install prompt never interrupts broker mobile pages and
// stays available as an optional menu action (todo: install prompt nag).
// Mobile viewport + synthetic beforeinstallprompt: (1) no banner/overlay may
// appear, (2) the mobile menu must offer "Install PropAI (optional)".
const APP = "http://localhost:3100";

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/google-chrome",
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--hide-scrollbars"],
});
const page = await browser.newPage();
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
await page.emulate({
  viewport: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36",
});
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
  const reply = (body) => req.respond({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  if (url.includes("/api/market/access")) { reply({ authenticated: true, whatsapp_connected: false, market_groups_confirmed: false, trial_active: false, paid_active: false, market_unlocked: false, trial_state: "not_started", trial_started_at: null, trial_ends_at: null, trial_first_search: null }); return; }
  if (url.includes("/api/external/v1/keys")) { reply({ keys: [] }); return; }
  if (url.includes("/api/phones")) { reply({ phones: [] }); return; }
  if (url.includes("/api/dashboard/whatsapp-status")) { reply({ connected: false, state: "stopped", status_available: true, status_stale: false }); return; }
  reply({});
});

await page.goto(APP + "/setup", { waitUntil: "domcontentloaded", timeout: 90000 });
await new Promise((r) => setTimeout(r, 7000));

// Browser offers installation: must NOT open any banner/dialog/overlay.
await page.evaluate(() => {
  window.dispatchEvent(new Event("beforeinstallprompt"));
});
await new Promise((r) => setTimeout(r, 1500));
const afterOffer = await page.evaluate(() => {
  const text = document.body.innerText.replace(/\s+/g, " ");
  const overlay = Array.from(document.querySelectorAll("body > div, body > section, [role=dialog], [class*=fixed], [class*=modal]"))
    .some((el) => /install/i.test(el.innerText || "") && !el.innerText.includes("Four steps"));
  return {
    installTextOnPage: /install propai/i.test(text),
    suspiciousInstallOverlay: overlay,
  };
});
await page.screenshot({ path: "/tmp/install-prompt-page.png", fullPage: false });

// Open the mobile menu: install must be offered there, as an optional action.
const menuOpened = await page.evaluate(() => {
  const btn = Array.from(document.querySelectorAll("button")).find((b) => (b.innerText || "").trim() === "Menu");
  if (btn) { btn.click(); return true; }
  return false;
});
await new Promise((r) => setTimeout(r, 2500));
const drawerVisible = await page.evaluate(() => {
  const drawer = document.querySelector("[class*=drawer], aside, nav");
  return Array.from(document.querySelectorAll("*")).some((el) => {
    const style = window.getComputedStyle(el);
    return (el.innerText || "").includes("Install PropAI (optional)") && style.visibility !== "hidden" && style.display !== "none" && el.getBoundingClientRect().width > 0 && el.tagName === "BUTTON";
  });
});
const menuState = await page.evaluate(() => {
  const text = document.body.innerText.replace(/\s+/g, " ");
  return { menuInstallOffer: text.includes("Install PropAI (optional)") };
});
await page.screenshot({ path: "/tmp/install-prompt-menu.png", fullPage: false });

console.log("STATE:", JSON.stringify({ menuOpened, drawerVisible, ...afterOffer, ...menuState }));
await browser.close();
