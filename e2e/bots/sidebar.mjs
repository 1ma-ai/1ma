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
    mode: JSON.parse(server.bb([SIDEBAR, "prefs", "get", "organizationMode"])),
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

// Bots start expanded, like bb's parent threads; a collapsed one opens here.
export async function expandBot(page, botName) {
  const name = page.locator("[data-1ma-bot-row] .bb-thread-title", { hasText: botName });
  await name.waitFor({ timeout: 30_000 });
  const expand = page.getByRole("button", { name: `Expand ${botName} conversations` });
  if ((await expand.count()) > 0) await expand.click();
}

const boxOf = async (locator) => {
  const box = await locator.first().boundingBox();
  if (box === null) throw new Error(`not drawn: ${locator}`);
  return box;
};

// What makes a parent row look like bb's: where its chevron sits after the
// title, the chevron's size, the children's indent and the guide line's place.
export async function parentRowGeometry(page, { row, title, chevron, child }) {
  const [rowBox, titleBox, chevronBox, childBox] = await Promise.all(
    [row, title, chevron, child].map(boxOf),
  );
  const childPadding = await child
    .first()
    .evaluate((link) => getComputedStyle(link.closest("[data-sidebar-rename-row]")).paddingLeft);
  const guide = await child.first().evaluate((link) => {
    const rowLeft = link.closest("[data-sidebar-rename-row]").getBoundingClientRect().left;
    for (let node = link.parentElement; node !== null; node = node.parentElement) {
      const line = [...node.children].find(
        (element) =>
          element.matches("span[aria-hidden='true']") &&
          element.className.includes("bg-border-hairline"),
      );
      if (line) return Math.round(line.getBoundingClientRect().left - rowLeft);
    }
    return null;
  });
  const background = await row
    .first()
    .evaluate((element) => getComputedStyle(element).backgroundColor);
  return {
    background,
    chevronAfterTitle: Math.round(chevronBox.x - (titleBox.x + titleBox.width)),
    chevronSize: [Math.round(chevronBox.width), Math.round(chevronBox.height)],
    childIndent: Math.round(childBox.x - rowBox.x),
    childPadding,
    guide,
  };
}

export const iconOf = (button) =>
  button.first().evaluate((element) => element.querySelector("svg")?.outerHTML ?? null);

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
    throw new Error(`${label}: ${error.message}\npage text: ${text.slice(0, 2000)}`, {
      cause: error,
    });
  }
}

const topOf = async (locator) => {
  const box = await locator.first().boundingBox();
  if (box === null) throw new Error(`not drawn: ${locator}`);
  return box.y;
};

// The sidebar draws groups as a flat column: a header, then its rows. A row
// belongs to the last header drawn above it.
export async function groupsOf(page, headers, threadIds) {
  const tops = Object.fromEntries(
    await Promise.all(
      headers.map(async (name) => [name, await topOf(page.getByText(name, { exact: true }))]),
    ),
  );
  const rows = await Promise.all(
    threadIds.map(async (id) => [id, await topOf(threadLink(page, id))]),
  );
  const ordered = Object.entries(tops).toSorted(([, a], [, b]) => a - b);
  return {
    order: ordered.map(([name]) => name),
    groupOf: Object.fromEntries(
      rows.map(([id, top]) => [
        id,
        ordered.findLast(([, headerTop]) => headerTop < top)?.[0] ?? null,
      ]),
    ),
  };
}

// Space between a group header and the last thread row drawn above it.
export async function gapAbove(page, header) {
  const top = await topOf(page.getByText(header, { exact: true }));
  const bottoms = await page
    .locator("[data-sidebar-thread-id]")
    .evaluateAll((rows) => rows.map((row) => row.getBoundingClientRect().bottom));
  const above = bottoms.filter((bottom) => bottom <= top);
  if (above.length === 0) throw new Error(`no thread row above ${header}`);
  return top - Math.max(...above);
}
