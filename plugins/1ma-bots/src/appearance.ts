import { COLORS, FACES, SHAPES, type Appearance } from "./contract.js";

export function randomAppearance(random: () => number = Math.random): Appearance {
  const pick = <T,>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
  return { shape: pick(SHAPES), face: pick(FACES), color: pick(COLORS) };
}
