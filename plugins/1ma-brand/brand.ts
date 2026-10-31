export const BRAND = "1ma";
export const BB_BRAND = "bb";
export const TITLE_SEPARATOR = " · ";

export const FAVICON_SIZES = [32, 16] as const;
export type FaviconSize = (typeof FAVICON_SIZES)[number];
export const FAVICON_LINK_IDS: Record<FaviconSize, string> = { 32: "favicon-32", 16: "favicon-16" };
export const MANIFEST_LINK_ID = "app-manifest";
export const APPLE_TOUCH_ICON_LINK_ID = "apple-touch-icon";
export const FAVICON_COLOR_STORAGE_KEY = "bb.faviconColor";
export const UNREAD_BADGE_FILL = "#e00000";

export const FAVICON_COLOR_VALUES: Readonly<Record<string, string>> = {
  red: "#e5484d",
  orange: "#f76b15",
  yellow: "#ffba18",
  green: "#30a46c",
  teal: "#12a594",
  blue: "#0090ff",
  purple: "#8e4ec6",
  pink: "#d6409f",
};

export interface BrandAsset {
  readonly file: string;
  readonly type: string;
}

export const BRAND_ASSETS: readonly BrandAsset[] = [
  { file: "wordmark.svg", type: "image/svg+xml" },
  { file: "icon.svg", type: "image/svg+xml" },
  { file: "favicon-16.png", type: "image/png" },
  { file: "favicon-32.png", type: "image/png" },
  { file: "app-icon-192.png", type: "image/png" },
  { file: "app-icon-192-maskable.png", type: "image/png" },
  { file: "app-icon-512.png", type: "image/png" },
  { file: "app-icon-512-maskable.png", type: "image/png" },
  { file: "apple-touch-icon.png", type: "image/png" },
];

export const WORDMARK_FILE = "wordmark.svg";
export const ICON_FILE = "icon.svg";
export const AUTHOR_AVATAR_SELECTOR = '[role="img"][aria-label$="avatar"]';

export const MANIFEST_FILE = "manifest.webmanifest";
export const MANIFEST_TYPE = "application/manifest+json";

export function assetBase(pluginId: string): string {
  return `/api/v1/plugins/${pluginId}/http`;
}

export function rebrandTitle(title: string): string {
  if (title === BB_BRAND) return BRAND;
  const suffix = `${TITLE_SEPARATOR}${BB_BRAND}`;
  if (title.endsWith(suffix)) return `${title.slice(0, -BB_BRAND.length)}${BRAND}`;
  return title;
}

export function isBbLogoSource(src: string): boolean {
  let pathname: string;
  try {
    pathname = new URL(src, "http://brand.invalid").pathname;
  } catch {
    return false;
  }
  return /(^|\/)bb-logo(-[A-Za-z0-9_-]+)?\.svg$/u.test(pathname);
}

export function faviconFile(size: FaviconSize): string {
  return `favicon-${size}.png`;
}

export interface LogoReplacement {
  file: string;
  widthAuto: boolean;
}

export function logoReplacement(alt: string | null): LogoReplacement {
  return alt === BB_BRAND
    ? { file: WORDMARK_FILE, widthAuto: true }
    : { file: ICON_FILE, widthAuto: false };
}

export function readFaviconColor(read: (key: string) => string | null): string | null {
  try {
    const value = read(FAVICON_COLOR_STORAGE_KEY);
    return value !== null && Object.hasOwn(FAVICON_COLOR_VALUES, value) ? value : null;
  } catch {
    return null;
  }
}

export interface UnreadBadgeDot {
  centerX: number;
  centerY: number;
  radius: number;
}

export function unreadBadgeDot(width: number, height: number): UnreadBadgeDot {
  const scale = Math.min(width, height) / 32;
  return { centerX: 28 * scale, centerY: 6 * scale, radius: 3.5 * scale };
}

export function looksLikeBadge(rgba: ArrayLike<number>): boolean {
  const red = rgba[0] ?? 0;
  const green = rgba[1] ?? 0;
  const blue = rgba[2] ?? 0;
  const alpha = rgba[3] ?? 0;
  return red >= 170 && green <= 90 && blue <= 90 && alpha >= 200;
}

export interface WebManifestIcon {
  src: string;
  sizes: string;
  type: string;
  purpose: "any" | "maskable";
}

export interface WebManifest {
  name: string;
  short_name: string;
  start_url: string;
  scope: string;
  display: "standalone";
  background_color: string;
  theme_color: string;
  icons: WebManifestIcon[];
}

export function buildManifest(base: string): WebManifest {
  const icon = (size: 192 | 512, purpose: "any" | "maskable"): WebManifestIcon => ({
    src: `${base}/app-icon-${size}${purpose === "maskable" ? "-maskable" : ""}.png`,
    sizes: `${size}x${size}`,
    type: "image/png",
    purpose,
  });
  return {
    name: BRAND,
    short_name: BRAND,
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#000000",
    theme_color: "#ffffff",
    icons: [icon(192, "any"), icon(512, "any"), icon(192, "maskable"), icon(512, "maskable")],
  };
}
