import { describe, expect, it, vi } from "vitest";
import {
  createAutoUpdates,
  QUIET_MS,
  type AutoUpdatesDeps,
  type ThreadState,
  type UpdateWork,
} from "./auto-updates.js";

const idle: ThreadState = {
  status: "idle",
  backgroundAgents: 0,
  backgroundCommands: 0,
  workflows: 0,
};

const work: UpdateWork = {
  providers: [
    { hostId: "mac", hostName: "MacBook", providerId: "codex" },
    { hostId: "mac", hostName: "MacBook", providerId: "claude-code" },
  ],
  plugins: [
    { id: "1ma-auto-updates", fromOneMa: true },
    { id: "pool-usage", fromOneMa: true },
  ],
};

const everyUpdate = [
  "codex on MacBook",
  "claude-code on MacBook",
  "plugin pool-usage",
  "plugin 1ma-auto-updates",
];

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function setup(overrides: Partial<AutoUpdatesDeps> = {}) {
  let now = 1_000_000;
  const calls: string[] = [];
  const decisions: string[] = [];
  const deps: AutoUpdatesDeps = {
    selfId: "1ma-auto-updates",
    now: () => now,
    sleep: async () => {
      calls.push("settle");
      decisions.push(updates.decideDispatch().action);
    },
    choices: async () => ({ providers: true, plugins: true, otherPlugins: false }),
    threads: async () => [idle],
    findWork: async () => work,
    installProvider: async ({ providerId }) => {
      calls.push(`provider ${providerId}`);
      decisions.push(updates.decideDispatch().action);
      return true;
    },
    updatePlugin: async (pluginId) => {
      calls.push(`plugin ${pluginId}`);
      decisions.push(updates.decideDispatch().action);
      return true;
    },
    releaseHeld: () => calls.push("release"),
    warn: vi.fn(),
    ...overrides,
  };
  const updates = createAutoUpdates(deps, (update) => `held for ${update}`);
  return {
    deps,
    updates,
    calls,
    decisions,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("installing updates while 1ma is quiet", () => {
  it("waits for fifteen quiet minutes, then installs one update at a time and holds new messages during each", async () => {
    const { updates, calls, decisions, advance } = setup();

    advance(QUIET_MS - 1);
    expect(await updates.run()).toEqual({ kind: "recent-activity" });
    expect(calls).toEqual([]);

    advance(1);
    expect(await updates.run()).toEqual({
      kind: "attempted",
      installed: everyUpdate,
      failed: [],
      postponed: [],
    });
    expect(calls).toEqual([
      "settle",
      "provider codex",
      "release",
      "settle",
      "provider claude-code",
      "release",
      "settle",
      "plugin pool-usage",
      "release",
      "settle",
      "plugin 1ma-auto-updates",
      "release",
    ]);
    expect(new Set(decisions)).toEqual(new Set(["wait"]));
    expect(updates.decideDispatch()).toEqual({ action: "proceed" });
  });

  it("names the update a held message waits for and asks core to try it again soon", async () => {
    let held: unknown = null;
    const { updates, advance } = setup({
      sleep: async () => {
        held ??= updates.decideDispatch();
      },
    });
    advance(QUIET_MS);
    await updates.run();
    expect(held).toEqual({
      action: "wait",
      reason: "held for codex on MacBook",
      sendAt: 1_000_000 + QUIET_MS + 30_000,
    });
  });

  it.each([
    ["a turn is running", { ...idle, status: "active" }],
    ["a turn is starting", { ...idle, status: "starting" }],
    ["a background agent works", { ...idle, backgroundAgents: 1 }],
    ["a background command runs", { ...idle, backgroundCommands: 1 }],
    ["a workflow runs", { ...idle, workflows: 1 }],
  ])("stays away while %s", async (_case, thread) => {
    const findWork = vi.fn(async () => work);
    const { updates, calls, advance } = setup({
      threads: async () => [idle, thread],
      findWork,
    });
    advance(QUIET_MS);
    expect(await updates.run()).toEqual({ kind: "busy" });
    expect(findWork).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it("treats threads it cannot read as busy", async () => {
    const { updates, calls, advance } = setup({ threads: async () => null });
    advance(QUIET_MS);
    expect(await updates.run()).toEqual({ kind: "busy" });
    expect(calls).toEqual([]);
  });

  it("steps back and releases held messages if a turn started while it settled", async () => {
    const threads = vi
      .fn<AutoUpdatesDeps["threads"]>()
      .mockResolvedValueOnce([idle])
      .mockResolvedValue([{ ...idle, status: "active" }]);
    const { updates, calls, advance } = setup({ threads });
    advance(QUIET_MS);
    expect(await updates.run()).toEqual({
      kind: "attempted",
      installed: [],
      failed: [],
      postponed: everyUpdate,
    });
    expect(calls).toEqual(["settle", "release"]);
    expect(updates.decideDispatch()).toEqual({ action: "proceed" });
  });

  it("checks again before every update and leaves the rest for later once work starts", async () => {
    const threads = vi
      .fn<AutoUpdatesDeps["threads"]>()
      .mockResolvedValueOnce([idle])
      .mockResolvedValueOnce([idle])
      .mockResolvedValue([{ ...idle, backgroundCommands: 1 }]);
    const { updates, calls, advance } = setup({ threads });
    advance(QUIET_MS);
    expect(await updates.run()).toEqual({
      kind: "attempted",
      installed: ["codex on MacBook"],
      failed: [],
      postponed: ["claude-code on MacBook", "plugin pool-usage", "plugin 1ma-auto-updates"],
    });
    expect(calls).toEqual(["settle", "provider codex", "release", "settle", "release"]);
  });

  it("reads the settings again before every update and leaves out a kind turned off meanwhile", async () => {
    let choices = { providers: true, plugins: true, otherPlugins: true };
    const { updates, calls, advance } = setup({
      choices: async () => choices,
      findWork: async () => ({
        providers: [{ hostId: "mac", hostName: "MacBook", providerId: "codex" }],
        plugins: [{ id: "focus-board", fromOneMa: false }],
      }),
      installProvider: async () => {
        calls.push("provider codex");
        choices = { ...choices, otherPlugins: false };
        return true;
      },
    });
    advance(QUIET_MS);
    expect(await updates.run()).toEqual({
      kind: "attempted",
      installed: ["codex on MacBook"],
      failed: [],
      postponed: ["plugin focus-board"],
    });
    expect(calls).not.toContain("plugin focus-board");
  });

  it("leaves the rest for later when work started and finished between two updates", async () => {
    const state = setup({
      installProvider: async ({ providerId }) => {
        state.calls.push(`provider ${providerId}`);
        state.updates.noteThreadActivity();
        return true;
      },
    });
    state.advance(QUIET_MS);
    expect(await state.updates.run()).toEqual({
      kind: "attempted",
      installed: ["codex on MacBook"],
      failed: [],
      postponed: ["claude-code on MacBook", "plugin pool-usage", "plugin 1ma-auto-updates"],
    });
  });

  it("restarts the quiet period whenever a thread runs, finishes or fails", async () => {
    const { updates, calls, advance } = setup();
    advance(QUIET_MS);
    updates.noteThreadActivity();
    advance(QUIET_MS - 1);
    expect(await updates.run()).toEqual({ kind: "recent-activity" });
    expect(calls).toEqual([]);
  });

  it("keeps going after an update fails and reports which one", async () => {
    const { updates, deps, advance } = setup({
      installProvider: async ({ providerId }) => {
        if (providerId === "codex") throw new Error("brew failed");
        return true;
      },
      updatePlugin: async (pluginId) => pluginId !== "pool-usage",
    });
    advance(QUIET_MS);
    expect(await updates.run()).toEqual({
      kind: "attempted",
      installed: ["claude-code on MacBook", "plugin 1ma-auto-updates"],
      failed: ["codex on MacBook", "plugin pool-usage"],
      postponed: [],
    });
    expect(deps.warn).toHaveBeenCalledWith("codex on MacBook: brew failed");
    expect(deps.warn).toHaveBeenCalledWith("plugin pool-usage: the update did not complete");
  });

  it("does nothing when every kind of update is turned off, and asks only for the kinds turned on", async () => {
    const off = setup({
      choices: async () => ({ providers: false, plugins: false, otherPlugins: false }),
    });
    off.advance(QUIET_MS);
    expect(await off.updates.run()).toEqual({ kind: "off" });

    const findWork = vi.fn(async () => ({ providers: [], plugins: [] }));
    const providersOnly = setup({
      choices: async () => ({ providers: true, plugins: false, otherPlugins: false }),
      findWork,
    });
    providersOnly.advance(QUIET_MS);
    expect(await providersOnly.updates.run()).toEqual({ kind: "nothing-to-update" });
    expect(findWork).toHaveBeenCalledWith({ providers: true, plugins: false, otherPlugins: false });
    expect(providersOnly.calls).toEqual([]);
  });

  it("keeps holding messages for as long as an install runs, however long that takes", async () => {
    const install = deferred();
    let decisionLate: unknown = null;
    const state = setup({
      installProvider: async () => {
        state.advance(60 * 60_000);
        decisionLate = state.updates.decideDispatch();
        await install.promise;
        return true;
      },
    });
    state.advance(QUIET_MS);
    const pass = state.updates.run();
    await vi.waitFor(() => expect(decisionLate).not.toBeNull());
    expect(decisionLate).toMatchObject({ action: "wait" });
    install.resolve();
    expect((await pass).kind).toBe("attempted");
    expect(state.updates.decideDispatch()).toEqual({ action: "proceed" });
  });

  it("runs one pass at a time", async () => {
    const settle = deferred();
    const { updates, advance } = setup({ sleep: () => settle.promise });
    advance(QUIET_MS);
    const first = updates.run();
    await vi.waitFor(() => expect(updates.decideDispatch().action).toBe("wait"));
    expect(await updates.run()).toEqual({ kind: "in-progress" });
    settle.resolve();
    expect((await first).kind).toBe("attempted");
  });
});
