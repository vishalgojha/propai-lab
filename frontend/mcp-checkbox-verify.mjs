import puppeteer from "puppeteer-core";

// Rendered verification of the "Allow private CRM writes" checkbox and saved-key
// permission display on /workspace/mcp (local dev server, intercepted APIs).
// Proves: checkbox starts checked, toggles stick (no snap-back), and saved keys
// display read-only vs writes-enabled from their actual scopes.
const APP = "http://localhost:3100";

const readOnlyKey = { id: "k-read", label: "Instinct", key_prefix: "ppai_read1234", scopes: ["inventory:read", "requirements:read", "matches:read"], expires_at: null, last_used_at: null, revoked_at: null, created_at: "2026-11-20T10:00:00Z" };
const writeKey = { id: "k-write", label: "Old write key", key_prefix: "ppai_writ5678", scopes: ["inventory:read", "requirements:read", "matches:read", "inventory:write", "requirements:write", "standing_searches:write", "followups:write"], expires_at: null, last_used_at: null, revoked_at: null, created_at: "2026-11-19T10:00:00Z" };

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
  if (url.includes("/api/external/v1/keys")) { reply({ keys: [readOnlyKey, writeKey] }); return; }
  if (url.includes("/api/external/v1/approvals")) { reply({ approvals: [] }); return; }
  if (url.includes("/api/dashboard/whatsapp-status")) { reply({ connected: true, phone: "+919820056180", state: "open", status_stale: false, status_available: true }); return; }
  if (url.includes("/api/phones")) { reply({ phones: [] }); return; }
  reply({});
});

await page.goto(APP + "/workspace/mcp", { waitUntil: "domcontentloaded", timeout: 90000 });
await new Promise((r) => setTimeout(r, 8000));

// Expand the Advanced section containing the checkbox.
await page.evaluate(() => {
  const summary = Array.from(document.querySelectorAll("summary")).find((s) => s.innerText.includes("Advanced"));
  if (summary && !summary.parentElement.open) summary.click();
});
await new Promise((r) => setTimeout(r, 800));

const readCheckbox = () => page.evaluate(() => {
  const box = Array.from(document.querySelectorAll("input[type=checkbox]")).find((c) => c.closest("label")?.innerText.includes("Allow private CRM writes"));
  return box ? box.checked : null;
});
const initial = await readCheckbox();
await page.evaluate(() => {
  const box = Array.from(document.querySelectorAll("input[type=checkbox]")).find((c) => c.closest("label")?.innerText.includes("Allow private CRM writes"));
  box?.click();
});
await new Promise((r) => setTimeout(r, 2500));
const afterUncheck = await readCheckbox();
await page.evaluate(() => {
  const box = Array.from(document.querySelectorAll("input[type=checkbox]")).find((c) => c.closest("label")?.innerText.includes("Allow private CRM writes"));
  box?.closest("label")?.scrollIntoView({ block: "center" });
});
await new Promise((r) => setTimeout(r, 400));
await page.screenshot({ path: "/tmp/mcp-checkbox-unchecked.png", fullPage: false });
await page.evaluate(() => {
  const box = Array.from(document.querySelectorAll("input[type=checkbox]")).find((c) => c.closest("label")?.innerText.includes("Allow private CRM writes"));
  box?.click();
});
await new Promise((r) => setTimeout(r, 2500));
const afterRecheck = await readCheckbox();
await page.evaluate(() => {
  const box = Array.from(document.querySelectorAll("input[type=checkbox]")).find((c) => c.closest("label")?.innerText.includes("Allow private CRM writes"));
  box?.closest("label")?.scrollIntoView({ block: "center" });
});
await new Promise((r) => setTimeout(r, 400));
await page.screenshot({ path: "/tmp/mcp-checkbox-checked.png", fullPage: false });

const keyRows = await page.evaluate(() => {
  const text = document.body.innerText.replace(/\s+/g, " ");
  return {
    readOnlyShown: text.includes("Read only"),
    writesEnabledShown: text.includes("Private CRM writes enabled"),
    noActiveKeysShown: text.includes("No active external API keys found"),
    keyLabels: [text.includes("Instinct"), text.includes("Old write key")],
  };
});
console.log("STATE:", JSON.stringify({ initial, afterUncheck, afterRecheck, ...keyRows }));
await browser.close();
