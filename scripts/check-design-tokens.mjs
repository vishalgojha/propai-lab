import { execFileSync } from "node:child_process";

// Enforce the token boundary on new UI code without hiding the existing
// migration debt. Only newly staged lines are governed by this check.
const files = execFileSync("git", ["diff", "--cached", "--name-only", "--diff-filter=AM"], { encoding: "utf8" })
  .split("\n")
  .filter((file) => /^(frontend|apps\/www)\/src\/.*\.(tsx?|css|scss)$/.test(file));
const colorPattern = /(?:#[0-9a-f]{3,8}\b|\b(?:bg|text|border|ring|divide)-(?:black|white|slate|gray|zinc|red|blue|green|emerald|teal|amber|orange|violet|rose|sky)-)/i;
const violations = [];

for (const file of files) {
  const diff = execFileSync("git", ["diff", "--cached", "--unified=0", "--", file], { encoding: "utf8" });
  for (const line of diff.split("\n")) {
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    if (file.endsWith("unified-tokens.css") || file.endsWith("design-tokens.ts")) continue;
    if (colorPattern.test(line) && !line.includes("var(--")) violations.push(`${file}: ${line.slice(1).trim()}`);
  }
}

if (violations.length) {
  console.error("Hardcoded UI colors found in newly staged code. Use unified design tokens:\n" + violations.join("\n"));
  process.exit(1);
}
console.log(`Design-token check passed (${files.length} staged UI files).`);
