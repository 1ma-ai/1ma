import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.js";

function setup(builtIn: { enabled: boolean } | null, preferences: Record<string, unknown>) {
  let reads = 0;
  const host = createFakePluginHost({
    pluginId: "1ma-sidebar",
    sdk: {
      plugins: {
        list: async () => ({
          plugins: builtIn === null ? [] : [{ id: "thread-list", enabled: builtIn.enabled }],
        }),
        callRpc: async () => {
          reads += 1;
          return { preferences };
        },
      },
      system: { uiPreferences: { list: async () => ({ preferences: {} }) } },
    },
  });
  return { host, reads: () => reads };
}

const list = async (host: ReturnType<typeof createFakePluginHost>) =>
  (await host.harness.behavior.callRpc("listPreferences", null)) as {
    preferences: Record<string, unknown>;
  };

describe("the owner's layout from the built-in thread list", () => {
  it("is copied once, on the first read, and not again after a reload", async () => {
    const t = setup({ enabled: true }, { organizationMode: "machine" });
    await plugin(t.host.bb);
    expect((await list(t.host)).preferences.organizationMode).toBe("machine");
    const reloaded = await t.host.harness.lifecycle.reload(plugin);
    await list(reloaded);
    expect(t.reads()).toBe(1);
  });

  it("is not read from a disabled or missing built-in list", async () => {
    for (const builtIn of [{ enabled: false }, null]) {
      const t = setup(builtIn, { organizationMode: "machine" });
      await plugin(t.host.bb);
      expect((await list(t.host)).preferences.organizationMode).toBe("chronological");
      expect(t.reads()).toBe(0);
    }
  });

  it("a failed read is retried on the next read, not marked done", async () => {
    let fail = true;
    const host = createFakePluginHost({
      pluginId: "1ma-sidebar",
      sdk: {
        plugins: {
          list: async () => ({ plugins: [{ id: "thread-list", enabled: true }] }),
          callRpc: async () => {
            if (fail) throw new Error("thread-list is reloading");
            return { preferences: { organizationMode: "project" } };
          },
        },
        system: { uiPreferences: { list: async () => ({ preferences: {} }) } },
      },
    });
    await plugin(host.bb);
    expect((await list(host)).preferences.organizationMode).toBe("chronological");
    fail = false;
    expect((await list(host)).preferences.organizationMode).toBe("project");
  });

  it("registers the Show bots setting, on by default", async () => {
    const t = setup(null, {});
    await plugin(t.host.bb);
    expect(t.host.harness.registrations.settingsDescriptors.showBots).toMatchObject({
      type: "boolean",
      default: true,
    });
  });
});

describe("Codex review of stage 2: the first read never overwrites stored preferences", () => {
  it("keeps a layout already stored in 1ma Sidebar", async () => {
    let available = false;
    const host = createFakePluginHost({
      pluginId: "1ma-sidebar",
      sdk: {
        plugins: {
          list: async () => ({ plugins: [{ id: "thread-list", enabled: true }] }),
          callRpc: async () => {
            if (!available) throw new Error("thread-list is not loaded yet");
            return { preferences: { organizationMode: "machine", sortDirection: "ascending" } };
          },
        },
        system: { uiPreferences: { list: async () => ({ preferences: {} }) } },
      },
    });
    await plugin(host.bb);
    await host.harness.behavior.callRpc("setPreference", {
      key: "organizationMode",
      value: "project",
    });
    available = true;
    const { preferences } = await list(host);
    expect(preferences.organizationMode).toBe("project");
    expect(preferences.sortDirection).toBe("ascending");
  });

  it("at load, the built-in list's layout comes before bb's old sidebar settings", async () => {
    const host = createFakePluginHost({
      pluginId: "1ma-sidebar",
      sdk: {
        plugins: {
          list: async () => ({ plugins: [{ id: "thread-list", enabled: true }] }),
          callRpc: async () => ({ preferences: { organizationMode: "machine" } }),
        },
        system: {
          uiPreferences: {
            list: async () => ({
              preferences: { "sidebar.organizationMode": { value: "project" } },
            }),
          },
        },
      },
    });
    await plugin(host.bb);
    expect((await list(host)).preferences.organizationMode).toBe("machine");
  });
});

describe("Codex re-review of stage 2: the built-in list's layout once it is ready", () => {
  function coldStart(builtIn: Record<string, unknown>, legacy: Record<string, unknown>) {
    let ready = false;
    const host = createFakePluginHost({
      pluginId: "1ma-sidebar",
      sdk: {
        plugins: {
          list: async () => ({ plugins: [{ id: "thread-list", enabled: true }] }),
          callRpc: async () => {
            if (!ready) throw new Error("thread-list is not loaded yet");
            return { preferences: builtIn };
          },
        },
        system: {
          uiPreferences: {
            list: async () => ({
              preferences: Object.fromEntries(
                Object.entries(legacy).map(([key, value]) => [key, { value }]),
              ),
            }),
          },
        },
      },
    });
    return { host, ready: () => (ready = true) };
  }

  it("replaces values taken from old sidebar settings and keeps what the owner chose here", async () => {
    const t = coldStart(
      { organizationMode: "machine", sortDirection: "ascending" },
      { "sidebar.organizationMode": "project" },
    );
    await plugin(t.host.bb);
    expect((await list(t.host)).preferences.organizationMode).toBe("project");
    await t.host.harness.behavior.callRpc("setPreference", {
      key: "sortDirection",
      value: "descending",
    });
    t.ready();
    const { preferences } = await list(t.host);
    expect(preferences.organizationMode).toBe("machine");
    expect(preferences.sortDirection).toBe("descending");
  });

  it("keeps an old-settings key once the owner chose it here, even back to the default", async () => {
    const t = coldStart({ organizationMode: "machine" }, { "sidebar.organizationMode": "project" });
    await plugin(t.host.bb);
    await t.host.harness.behavior.callRpc("resetPreference", { key: "organizationMode" });
    t.ready();
    expect((await list(t.host)).preferences.organizationMode).toBe("chronological");
  });

  it("a default in the built-in list wins over an old non-default setting", async () => {
    const t = coldStart(
      { organizationMode: "chronological" },
      { "sidebar.organizationMode": "project" },
    );
    await plugin(t.host.bb);
    t.ready();
    expect((await list(t.host)).preferences.organizationMode).toBe("chronological");
  });

  it("when the built-in list answers at load, old sidebar settings are not migrated at all", async () => {
    const t = coldStart(
      { organizationMode: "chronological" },
      { "sidebar.organizationMode": "project" },
    );
    t.ready();
    await plugin(t.host.bb);
    expect((await list(t.host)).preferences.organizationMode).toBe("chronological");
  });
});

describe("Codex review: copied row actions belong to 1ma Sidebar", () => {
  it("maps the built-in list's own Move action to this plugin's", async () => {
    const host = createFakePluginHost({
      pluginId: "1ma-sidebar",
      sdk: {
        plugins: {
          list: async () => ({ plugins: [{ id: "thread-list", enabled: true }] }),
          callRpc: async () => ({
            preferences: { rowActions: ["thread-list/move", "bb--core/pin"] },
          }),
        },
        system: { uiPreferences: { list: async () => ({ preferences: {} }) } },
      },
    });
    await plugin(host.bb);
    expect((await list(host)).preferences.rowActions).toEqual(["1ma-sidebar/move", "bb--core/pin"]);
  });
});

describe("Codex review at b02a4ce: no built-in list to copy from", () => {
  it("keeps the old sidebar layout when the stock list is disabled or missing", async () => {
    for (const plugins of [[{ id: "thread-list", enabled: false }], []]) {
      const host = createFakePluginHost({
        pluginId: "1ma-sidebar",
        sdk: {
          plugins: {
            list: async () => ({ plugins }),
            callRpc: async () => {
              throw new Error("must not be called");
            },
          },
          system: {
            uiPreferences: {
              list: async () => ({
                preferences: { "sidebar.organizationMode": { value: "project" } },
              }),
            },
          },
        },
      });
      await plugin(host.bb);
      expect((await list(host)).preferences.organizationMode).toBe("project");
    }
  });
});
