import puppeteer from "puppeteer-core";
const APP = "http://localhost:3100";
const browser = await puppeteer.launch({ executablePath: "/usr/bin/google-chrome", headless: "new", args: ["--no-sandbox", "--disable-dev-shm-usage", "--hide-scrollbars"] });
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
  if (url.startsWith(APP + "/api/")) { req.respond({ status: 200, contentType: "application/json", body: "{}" }); return; }
  req.continue();
});
await page.goto(APP + "/search", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForFunction(() => document.body.innerHTML.includes("Search runs through your assistant"), { timeout: 45000, polling: 500 });
await new Promise((r) => setTimeout(r, 1500));
const state = await page.evaluate(() => ({ url: location.pathname,
  retiredNoticeShown: document.body.innerHTML.includes("assistant retired"),
  hasBrokerPoolLine: document.body.innerHTML.includes("explicitly shared to the broker pool"),
  wwwLink: !!document.querySelector('a[href="https://www.propai.live/search"]'),
  connectLink: !!document.querySelector('a[href="/workspace/instinct"]'),
}));
await page.screenshot({ path: "/tmp/search-page.png" });
console.log("STATE:", JSON.stringify(state));
await browser.close();
