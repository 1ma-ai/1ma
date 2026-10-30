import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./themes/1ma.css", import.meta.url), "utf8");

function block(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start, `block ${selector}`).toBeGreaterThanOrEqual(0);
  const end = css.indexOf("\n}", start);
  return css.slice(start, end);
}

function tokens(text: string): Map<string, string> {
  return new Map(
    Array.from(text.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g), (m) => [m[1]!, m[2]!.trim()]),
  );
}

const anchorsAndAccent = ["--canvas", "--ink", "--primary", "--primary-foreground"];
const textTiers = ["--muted-foreground", "--subtle-foreground", "--readback-foreground"];
const semantic = [
  "--destructive",
  "--destructive-foreground",
  "--destructive-text",
  "--warning",
  "--warning-text",
  "--attention",
  "--success",
  "--diff-added",
  "--diff-removed",
  "--pr-merged",
];
const fonts = ["--font-sans", "--font-serif", "--font-mono", "--font-terminal"];
const ansi = [
  ...Array.from({ length: 16 }, (_, i) => `--ansi-${i}`),
  ...Array.from({ length: 16 }, (_, i) => `--ansi-bg-fg-${i}`),
];

describe("1ma theme stylesheet", () => {
  const light = tokens(block(":root,\n.light"));
  const dark = tokens(block(".dark"));

  it("sets every documented bb theme token for light mode", () => {
    for (const token of [
      ...anchorsAndAccent,
      ...textTiers,
      ...semantic,
      ...fonts,
      ...ansi,
      "--radius",
    ]) {
      expect(light.has(token), token).toBe(true);
    }
  });

  it("re-sets the mode-dependent colors for dark mode", () => {
    for (const token of [...anchorsAndAccent, ...textTiers, ...semantic, ...ansi]) {
      expect(dark.has(token), token).toBe(true);
    }
  });

  it("keeps light and dark anchors readable: dark canvas is dark, light canvas is light", () => {
    expect(light.get("--canvas")).toMatch(/^oklch\(1 /);
    expect(dark.get("--canvas")).toMatch(/^oklch\(0\.1/);
  });

  it("does not pin internal bb tokens that must keep deriving from the anchors", () => {
    for (const token of [
      "--background",
      "--card",
      "--sidebar",
      "--border",
      "--file-accent",
      "--ring",
    ]) {
      expect(light.has(token), token).toBe(false);
      expect(dark.has(token), token).toBe(false);
    }
  });

  it("stays within bb's stylesheet limits and avoids @scope", () => {
    expect(Buffer.byteLength(css, "utf8")).toBeLessThan(256 * 1024);
    expect(css).not.toContain("@scope");
  });
});
