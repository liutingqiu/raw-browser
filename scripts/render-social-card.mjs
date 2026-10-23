#!/usr/bin/env node
/**
 * Renders assets/social-card.html to assets/social-card.png at 1280x640.
 * Upload it as the repository's social preview in GitHub settings.
 *
 *   node scripts/render-social-card.mjs
 */
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const CARD = path.join(ROOT, "assets", "social-card.html");
const OUT = path.join(ROOT, "assets", "social-card.png");

delete process.env.RAW_BROWSER_EXTERNAL_BRIDGE;
delete process.env.RAW_BROWSER_BRIDGE_BROWSER;
delete process.env.RAW_BROWSER_BRIDGE_TOKEN;
process.env.RAW_BROWSER_PROFILE = path.join(os.homedir(), ".raw", "demo-profile");
process.env.RAW_BROWSER_HEADLESS = "1";

const runtime = await import(pathToFileURL(path.join(ROOT, "dist", "browser.js")).href);

const script = `
const ui = await page.newTab(${JSON.stringify(pathToFileURL(CARD).href)});
await ui.cdpSend('Emulation.setDeviceMetricsOverride', {
  width: 1280, height: 640, deviceScaleFactor: 1, mobile: false,
});
await ui.sleep(600);
const shot = await ui.screenshot({ path: ${JSON.stringify(OUT)}, format: 'png', inline: false });
console.log('wrote ' + shot.path);
await ui.closeTab();
`;

try {
  const result = await runtime.runBrowserScript(script, { timeoutMs: 60_000 });
  console.log(result.text);
} finally {
  await runtime.closeBrowser();
}
