import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BRAND_ASSETS } from "./brand";

const RGB = 2;
const RGBA = 6;

function pngHeader(file: string): { width: number; height: number; colorType: number } {
  const bytes = readFileSync(new URL(`./assets/${file}`, import.meta.url));
  expect(bytes.subarray(12, 16).toString("ascii"), file).toBe("IHDR");
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    colorType: bytes[25] ?? -1,
  };
}

function expectedPng(file: string): { size: number; colorType: number } {
  if (file === "apple-touch-icon.png") return { size: 180, colorType: RGB };
  const size = Number(/-(\d+)(?:-|\.)/u.exec(file)?.[1]);
  return { size, colorType: file.includes("-maskable") ? RGB : RGBA };
}

describe("brand assets", () => {
  const pngs = BRAND_ASSETS.filter((asset) => asset.type === "image/png").map(
    (asset) => asset.file,
  );

  it("ships every PNG at the size its name promises", () => {
    for (const file of pngs) {
      const header = pngHeader(file);
      const expected = expectedPng(file);
      expect([header.width, header.height], file).toEqual([expected.size, expected.size]);
    }
  });

  it("keeps launcher icons opaque and the favicon and macOS-style tiles transparent", () => {
    for (const file of pngs) {
      expect(pngHeader(file).colorType, file).toBe(expectedPng(file).colorType);
    }
  });

  it("draws the app icon as the 31 squares of the pixel man", () => {
    const svg = readFileSync(new URL("./assets/icon.svg", import.meta.url), "utf8");
    expect(svg.match(/<rect /g)?.length).toBe(31);
  });

  it("ships monochrome SVG marks that follow the text color and never say bb", () => {
    for (const asset of BRAND_ASSETS.filter((entry) => entry.type === "image/svg+xml")) {
      const svg = readFileSync(new URL(`./assets/${asset.file}`, import.meta.url), "utf8");
      expect(svg, asset.file).toContain('fill="currentColor"');
      expect(svg, asset.file).not.toMatch(/\bbb\b/u);
    }
  });
});
