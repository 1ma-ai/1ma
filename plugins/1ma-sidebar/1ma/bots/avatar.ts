import type { Appearance } from "./contract.js";

const INK = "#1b1b1b";

const BODIES: Record<Appearance["shape"], (fill: string) => string> = {
  circle: (fill) => `<circle cx="16" cy="16" r="14" fill="${fill}"/>`,
  squircle: (fill) => `<rect x="3" y="3" width="26" height="26" rx="9" fill="${fill}"/>`,
  blob: (fill) =>
    `<path d="M16 2c7 0 13 4.5 13 12.5S24 30 15.5 30 3 25 3 17 9 2 16 2z" fill="${fill}"/>`,
  pill: (fill) => `<rect x="2" y="6" width="28" height="20" rx="10" fill="${fill}"/>`,
};

const FACES: Record<Appearance["face"], string> = {
  calm: `<rect x="10.5" y="11.5" width="3" height="6" rx="1.5" fill="${INK}"/><rect x="18.5" y="11.5" width="3" height="6" rx="1.5" fill="${INK}"/>`,
  happy: `<path d="M10 16c1-2.5 3-2.5 4 0M18 16c1-2.5 3-2.5 4 0" stroke="${INK}" stroke-width="2" fill="none" stroke-linecap="round"/>`,
  focused: `<path d="M10 14.5h4M18 14.5h4" stroke="${INK}" stroke-width="2.2" stroke-linecap="round"/>`,
  curious: `<circle cx="12" cy="14.5" r="2.4" fill="${INK}"/><circle cx="20.5" cy="14.5" r="1.5" fill="${INK}"/>`,
};

export function avatarSvg(appearance: Appearance): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">${BODIES[appearance.shape](appearance.color)}${FACES[appearance.face]}</svg>`;
}

export function avatarDataUrl(appearance: Appearance): string {
  return `data:image/svg+xml;utf8,${encodeURIComponent(avatarSvg(appearance))}`;
}
