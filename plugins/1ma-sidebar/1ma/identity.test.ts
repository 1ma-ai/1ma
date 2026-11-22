import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.js";
import { parsePreferenceValue } from "../shared/preferences.js";

const root = new URL("../", import.meta.url);
const BUILT_IN = "thread-list";

describe("1ma Sidebar next to bb's built-in thread list", () => {
  it("has its own plugin id, skill and row-action keys", () => {
    const manifest = JSON.parse(readFileSync(new URL("package.json", root), "utf8")) as {
      name: string;
      files: string[];
    };
    const id = manifest.name.replace(/^bb-plugin-/u, "");
    expect(id).toBe("1ma-sidebar");
    expect(manifest.files).toEqual(expect.arrayContaining(["skills", "PLUGIN_OVERVIEW.md"]));
    const skills = readdirSync(new URL("skills/", root)).map(
      (dir) =>
        /^name:\s*(.+)$/mu.exec(readFileSync(new URL(`skills/${dir}/SKILL.md`, root), "utf8"))?.[1],
    );
    expect(skills).toEqual(["1ma-sidebar"]);
    const parsed = parsePreferenceValue("rowActions", ["move"]);
    expect(parsed).toEqual({ success: true, value: ["1ma-sidebar/move"] });
    expect(JSON.stringify(parsed)).not.toContain(`${BUILT_IN}/`);
  });

  it("registers its CLI under its own id", async () => {
    const host = createFakePluginHost({
      pluginId: "1ma-sidebar",
      sdk: { system: { uiPreferences: { list: async () => ({ preferences: {} }) } } },
    });
    await plugin(host.bb);
    expect(host.harness.registrations.cli?.name).toBe("1ma-sidebar");
  });
});
