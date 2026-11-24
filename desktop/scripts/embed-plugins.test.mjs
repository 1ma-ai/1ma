import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { EMBEDDED, registeredNames, runtimeFiles } from "./embed-plugins.mjs";

const scratch = mkdtempSync(path.join(tmpdir(), "1ma-embed-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

function tree(registry) {
  const dir = mkdtempSync(path.join(scratch, "bb-"));
  const file = path.join(dir, "apps/server/src/services/plugins/builtin-registry.ts");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, registry);
  return dir;
}

describe("embedding the 1ma plugins", () => {
  test("reads the names patch 0014 registers from the bb tree", () => {
    const dir = tree(
      `export const ONE_MA_PLUGINS: readonly BundledPluginDefinition[] = [\n  "1ma-brand",\n  "1ma-theme",\n].map((name) => ({ name }));\n`,
    );
    assert.deepEqual(registeredNames(dir), ["1ma-brand", "1ma-theme"]);
  });

  test("refuses a tree without patch 0014", () => {
    assert.throws(
      () => registeredNames(tree("export const BUILTIN_PLUGINS = [];\n")),
      /patch 0014/u,
    );
  });

  test("every embedded plugin says which runtime files it needs", () => {
    for (const name of EMBEDDED) {
      const files = runtimeFiles(path.join(import.meta.dirname, "../../plugins", name));
      assert.ok(files.includes("PLUGIN_OVERVIEW.md"), name);
    }
    assert.ok(
      runtimeFiles(path.join(import.meta.dirname, "../../plugins/1ma-brand")).includes("assets"),
    );
    assert.ok(
      runtimeFiles(path.join(import.meta.dirname, "../../plugins/1ma-theme")).includes("themes"),
    );
  });
});
