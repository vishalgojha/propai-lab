// Verifies the dashboard ActionGrid in isolation: renders the real component
// via the dev-fixture route, captures a pixel, and proves each card's click
// targets the expected route by intercepting the client-side RSC fetch.
import puppeteer from "puppeteer-core";

const BASE = process.env.FIXTURE_BASE || "http://127.0.0.1:3100";
const URL_ = `${BASE}/dev-fixtures/action-grid`;

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/google-chrome",
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });

await page.goto(URL_, { waitUntil: "networkidle0", timeout: 60000 });
await page.waitForSelector(".dashboard-action-grid", { timeout: 30000 });
await new Promise(r => setTimeout(r, 500));
await page.screenshot({ path: "/tmp/action-grid-pixel.png" });

const labels = await page.$$eval(".dashboard-action-card", els => els.map(e => e.textContent.replace(/\s+/g, " ").trim()));
console.log("CARDS:", JSON.stringify(labels));

// Capture client-side navigation targets: Next app router fetches the RSC
// payload for the destination route on router.push.
const hits = [];
await page.setRequestInterception(true);
page.on("request", req => {
  const u = new URL(req.url());
  if (u.origin === new URL(BASE).origin && (u.pathname === "/inbox" || u.pathname === "/workspace/instinct" || u.pathname === "/whatsapp")) {
    hits.push(u.pathname + u.search);
    req.abort();
  } else {
    req.continue();
  }
});

async function clickCard(label) {
  const ok = await page.evaluate(l => {
    const btn = Array.from(document.querySelectorAll(".dashboard-action-card"))
      .find(e => e.textContent.includes(l));
    if (!btn) return false;
    btn.click();
    return true;
  }, label);
  await new Promise(r => setTimeout(r, 1200));
  return ok;
}

const results = {};
for (const label of ["Review Items", "Review market data", "Connect groups", "Connect your assistant"]) {
  results[label] = await clickCard(label);
}
await new Promise(r => setTimeout(r, 800));
console.log("CLICKED:", JSON.stringify(results));
console.log("NAV_HITS:", JSON.stringify(hits));
await browser.close();

const expect = ["/inbox", "/inbox", "/whatsapp?tab=groups", "/workspace/instinct"];
const pass = expect.every(e => hits.includes(e));
console.log(pass ? "PIXEL+CLICK PASS" : "FAIL");
process.exit(pass ? 0 : 1);
