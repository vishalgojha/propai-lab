import puppeteer from "puppeteer-core";

// Rendered verification of the guided setup flow (/setup, SetupGuide) with the
// full bundle and intercepted APIs. Modes:
//   new-user       nothing connected -> step 1 active, rest todo, trial not started
//   mid-progress   WhatsApp + groups + assistant key done -> step 4 active, trial countdown
//   legacy-unknown pre-tracker workspace -> step 4 honest "can't tell" note, not active
//   load-error     /market/access fails -> no step claims to be up next
const APP = "http://localhost:3100";
const MODE = process.argv[2] || "new-user";

const accessByMode = {
  "new-user": { authenticated: true, whatsapp_connected: false, market_groups_confirmed: false, trial_active: false, paid_active: false, market_unlocked: false, trial_state: "not_started", trial_started_at: null, trial_ends_at: null, trial_first_search: null },
  "mid-progress": { authenticated: true, whatsapp_connected: true, market_groups_confirmed: true, trial_active: true, paid_active: false, market_unlocked: true, trial_state: "active", trial_started_at: "2026-11-20T10:00:00Z", trial_ends_at: new Date(Date.now() + 11 * 86400000).toISOString(), trial_first_search: false },
  "legacy-unknown": { authenticated: true, whatsapp_connected: true, market_groups_confirmed: true, trial_active: true, paid_active: false, market_unlocked: true, trial_state: "legacy", trial_started_at: "2026-10-01T10:00:00Z", trial_ends_at: null, trial_first_search: null },
};
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
  if (url.includes("/api/market/access")) {
    if (MODE === "load-error") { req.respond({ status: 500, contentType: "application/json", body: "{}" }); return; }
    reply(accessByMode[MODE] || accessByMode["new-user"]); return;
  }
  if (url.includes("/api/external/v1/keys")) {
    reply({ keys: MODE === "mid-progress" || MODE === "legacy-unknown" ? [usableKey] : [] }); return;
  }
  if (url.includes("/api/phones")) { reply({ phones: [] }); return; }
  if (url.includes("/api/dashboard/whatsapp-status")) { reply({ connected: false, state: "stopped", status_available: true, status_stale: false }); return; }
  reply({});
});

await page.goto(APP + "/setup", { waitUntil: "domcontentloaded", timeout: 90000 });
await new Promise((r) => setTimeout(r, 8000));

const state = await page.evaluate(() => {
  const section = document.querySelector("[aria-label='PropAI setup guide']");
  const text = (section?.innerText || document.body.innerText).replace(/\s+/g, " ");
  const grab = (re) => (text.match(re) || ["n/a"])[0];
  return {
    stepsShown: ["Connect your WhatsApp", "Choose groups for extraction", "Approve your assistant's access", "Ask your first question"].map((t) => text.includes(t)),
    trialLine: grab(/(Your 15 free days start with your first assistant search\.|Free period: \d+ days? left[^.]*\.|Your free period has ended\.)/),
    legacyNoteShown: text.includes("we can't tell whether you've already asked"),
    guideHidden: text.includes("You hid the setup guide"),
    bodySnip: text.slice(0, 220),
  };
});
console.log("MODE:", MODE);
console.log("STATE:", JSON.stringify(state));
await page.screenshot({ path: `/tmp/setup-guide-${MODE}.png`, fullPage: false });
await browser.close();
