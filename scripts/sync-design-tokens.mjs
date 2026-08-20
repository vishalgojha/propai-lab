import { cpSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const source = resolve(root, "packages/design-tokens/tokens.css");
const targets = [
  resolve(root, "apps/www/src/styles/unified-tokens.css"),
  resolve(root, "frontend/src/styles/unified-tokens.css"),
];

for (const target of targets) {
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target);
}

console.log(`Synced unified design tokens to ${targets.length} apps.`);
