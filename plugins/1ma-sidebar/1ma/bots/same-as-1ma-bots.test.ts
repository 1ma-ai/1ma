import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

// bb installs each plugin by itself, so the panel carries its own copy of what
// 1ma-bots and the panel must agree on.
it.each(["contract.ts", "limits.ts", "avatar.ts", "branch.ts"])(
  "%s is 1ma-bots' own, byte for byte",
  (file) => {
    const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
    expect(read(`./${file}`)).toBe(read(`../../../1ma-bots/src/${file}`));
  },
);
