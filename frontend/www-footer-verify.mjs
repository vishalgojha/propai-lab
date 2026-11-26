import puppeteer from "puppeteer-core";
const APP = "http://localhost:3101";
const browser = await puppeteer.launch({ executablePath: "/usr/bin/google-chrome", headless: "new", args: ["--no-sandbox", "--disable-dev-shm-usage", "--hide-scrollbars"] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
await page.goto(APP + "/", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForFunction(() => document.body.innerHTML.includes("searchable through your assistant"), { timeout: 60000, polling: 500 });
await page.evaluate(() => { const f = document.querySelector("footer"); if (f) f.scrollIntoView({ block: "center" }); });
await new Promise((r) => setTimeout(r, 1500));
const state = await page.evaluate(() => {
  const text = (document.querySelector("footer")?.innerText || "").replace(/\s+/g, " ");
  return {
    newBrandLine: text.includes("makes their listings searchable through your assistant"),
    oldDirectLine: text.includes("direct line to the broker"),
    newBottomLine: text.includes("message the broker directly from the listing page"),
    oldNumberPromise: text.includes("get the listing and the broker"),
  };
});
await page.screenshot({ path: "/tmp/www-footer.png" });
console.log("STATE:", JSON.stringify(state));
await browser.close();
