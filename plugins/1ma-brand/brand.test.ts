import { describe, expect, it } from "vitest";
import {
  BRAND_ASSETS,
  buildManifest,
  faviconFile,
  isBbLogoSource,
  looksLikeBadge,
  readFaviconColor,
  rebrandTitle,
  unreadBadgeDot,
} from "./brand";

describe("rebrandTitle", () => {
  it("renames the bare home title and the bb suffix only", () => {
    expect(rebrandTitle("bb")).toBe("1ma");
    expect(rebrandTitle("Board · bb")).toBe("Board · 1ma");
    expect(rebrandTitle("Settings")).toBe("Settings");
  });

  it("leaves thread titles that merely mention bb alone", () => {
    expect(rebrandTitle("fix bb")).toBe("fix bb");
    expect(rebrandTitle("bb connect setup")).toBe("bb connect setup");
  });
});

describe("isBbLogoSource", () => {
  it("matches bb's hashed logo asset in any directory", () => {
    expect(isBbLogoSource("/assets/bb-logo-Ab12Cd.svg")).toBe(true);
    expect(isBbLogoSource("http://host:38890/assets/bb-logo.svg?v=1")).toBe(true);
  });

  it("ignores other images", () => {
    expect(isBbLogoSource("/assets/user-photo.png")).toBe(false);
    expect(isBbLogoSource("/assets/bb-logo.png")).toBe(false);
    expect(isBbLogoSource("data:image/svg+xml;base64,AAAA")).toBe(false);
  });
});

describe("favicon helpers", () => {
  it("picks the dark glyph for dark color schemes", () => {
    expect(faviconFile(32, false)).toBe("icon-32.png");
    expect(faviconFile(16, true)).toBe("icon-16-dark.png");
  });

  it("accepts only bb's known favicon colors from storage", () => {
    expect(readFaviconColor(() => "blue")).toBe("blue");
    expect(readFaviconColor(() => "magenta")).toBeNull();
    expect(readFaviconColor(() => null)).toBeNull();
    expect(
      readFaviconColor(() => {
        throw new Error("storage blocked");
      }),
    ).toBeNull();
  });

  it("places the unread dot where bb draws it and recognizes its red", () => {
    expect(unreadBadgeDot(32, 32)).toEqual({ centerX: 28, centerY: 6, radius: 3.5 });
    expect(unreadBadgeDot(16, 16)).toEqual({ centerX: 14, centerY: 3, radius: 1.75 });
    expect(looksLikeBadge([224, 0, 0, 255])).toBe(true);
    expect(looksLikeBadge([255, 255, 255, 255])).toBe(false);
    expect(looksLikeBadge([224, 0, 0, 40])).toBe(false);
  });
});

describe("buildManifest", () => {
  it("names the app 1ma and uses the pixel-man app icon in both purposes", () => {
    const manifest = buildManifest("/api/v1/plugins/1ma-brand/http");
    expect(manifest.name).toBe("1ma");
    expect(manifest.short_name).toBe("1ma");
    expect(manifest.background_color).toBe("#000000");
    expect(manifest.icons.map((icon) => [icon.src, icon.sizes, icon.purpose])).toEqual([
      ["/api/v1/plugins/1ma-brand/http/app-icon-192.png", "192x192", "any"],
      ["/api/v1/plugins/1ma-brand/http/app-icon-512.png", "512x512", "any"],
      ["/api/v1/plugins/1ma-brand/http/app-icon-192-maskable.png", "192x192", "maskable"],
      ["/api/v1/plugins/1ma-brand/http/app-icon-512-maskable.png", "512x512", "maskable"],
    ]);
    for (const icon of manifest.icons) {
      expect(BRAND_ASSETS.some((asset) => icon.src.endsWith(`/${asset.file}`))).toBe(true);
    }
  });
});
