import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { botsWrites } from "./bots-rpc.js";

it("every mutating method of 1ma-bots this sidebar calls has a row in the plan", () => {
  const plan = readFileSync(
    new URL("../../../docs/plan/2026-11-14-1ma-bots-and-sidebar-design.md", import.meta.url),
    "utf8",
  );
  const rows = [...plan.matchAll(/^\| `(bots\.[^`]+)`/gmu)].map((row) => row[1]);
  expect(rows).toEqual(expect.arrayContaining(Object.keys(botsWrites)));
});
