import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { requireEnv } from "../lib/servers.mjs";
import { SIDEBAR, screenshotDir, server } from "./harness.mjs";

// Playwright is installed by the workflow outside the repository, so the
// lockfile and the plugins stay free of a browser dependency.
const { chromium } = createRequire(path.join(requireEnv("E2E_PLAYWRIGHT_DIR"), "noop.js"))(
  "playwright",
);

export const VIEWPORT = { width: 1440, height: 900 };
const PROVIDER_KEY = `${SIDEBAR}/thread-list`;
const PROVIDER_PREFERENCE = "sidebar.threadListProvider";

const preferences = async () => (await server.api("GET", "/preferences/ui")).preferences ?? {};

// The copy keeps its list preferences in its own storage, so the grouping is
// set through its CLI; only the choice of the list itself is a UI preference.
export async function selectSidebar() {
  const current = (await preferences())[PROVIDER_PREFERENCE];
  await server.api("PUT", `/preferences/ui/${PROVIDER_PREFERENCE}`, {
    expectedRevision: current?.revision ?? 0,
    value: PROVIDER_KEY,
  });
  server.bb([SIDEBAR, "prefs", "set", "organizationMode", "project"]);
  return {
    provider: (await preferences())[PROVIDER_PREFERENCE]?.value,
    mode: server.bb([SIDEBAR, "prefs", "get", "organizationMode"]).trim(),
  };
}

export async function launch() {
  mkdirSync(screenshotDir, { recursive: true });
  return chromium.launch();
}

export async function openApp(browser, theme) {
  const context = await browser.newContext({ viewport: VIEWPORT, colorScheme: theme });
  const page = await context.newPage();
  const problems = [];
  page.on("pageerror", (error) => problems.push(error.message));
  await page.goto(server.url);
  // A fresh server starts with the first-run setup in front of the app.
  await page
    .getByRole("button", { name: "Skip setup" })
    .click({ timeout: 20_000 })
    .catch(() => {});
  return { context, page, problems };
}

export const threadLink = (page, threadId) =>
  page.locator(`a[data-sidebar-thread-id="${threadId}"]`);

export async function sectionIds(page) {
  return page.locator("[data-sidebar-section-id]").evaluateAll((nodes) =>
    nodes.map((node) => ({
      id: node.getAttribute("data-sidebar-section-id"),
      top: node.getBoundingClientRect().top,
    })),
  );
}

export async function expandBot(page, botName) {
  const toggle = page.getByRole("button", { name: new RegExp(`^${botName}: \\d+ conversations$`) });
  await toggle.waitFor({ timeout: 30_000 });
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
}

export const fontOf = (locator) =>
  locator.first().evaluate((node) => getComputedStyle(node).fontFamily);

export const screenshot = (page, name) =>
  page.screenshot({ path: path.join(screenshotDir, `${name}.png`) });

export async function waitDrawn(page, locator, label) {
  try {
    await locator.waitFor({ timeout: 60_000 });
  } catch (error) {
    await screenshot(page, `failed-${label}`);
    const text = await page.locator("body").innerText();
    throw new Error(`${label}: ${error.message}\npage text: ${text.slice(0, 2000)}`);
  }
}
