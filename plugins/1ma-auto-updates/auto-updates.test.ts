import { describe, expect, it, vi } from "vitest";
import {
  createAutoUpdates,
  MAX_HOLD_MS,
  QUIET_MS,
  type AutoUpdatesDeps,
  type ThreadState,
  type UpdateWork,
} from "./auto-updates.js";

const idle: ThreadState = { status: "idle", backgroundAgents: 0, workflows: 0 };

const work: UpdateWork = {
  providers: [
    { hostId: "mac", hostName: "MacBook", providerId: "codex" },
    { hostId: "mac", hostName: "MacBook", providerId: "claude-code" },
  ],
  plugins: ["1ma-auto-updates", "pool-usage"],
};

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
    choices: async () => ({ providers: true, plugins: true }),
    threads: async () => [idle],
    findWork: async () => work,
    installProvider: async ({ providerId }) => {
      calls.push(`provider ${providerId}`);
      decisions.push(updates.decideDispatch().action);
      return true;
    },
    updatePlugin: async (pluginId) => {
      calls.push(`plugin ${pluginId}`);
      return true;
    },
    releaseHeld: () => calls.push("release"),
    warn: vi.fn(),
    ...overrides,
  };
  const updates = createAutoUpdates(deps, "held for updates");
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
  it("waits for fifteen quiet minutes, then holds new messages while it installs", async () => {
    const { updates, calls, decisions, advance } = setup();

    advance(QUIET_MS - 1);
    expect(await updates.run()).toEqual({ kind: "recent-activity" });
    expect(calls).toEqual([]);

    advance(1);
    expect(await updates.run()).toEqual({
      kind: "updated",
      installed: [
        "codex on MacBook",
        "claude-code on MacBook",
        "plugin pool-usage",
        "plugin 1ma-auto-updates",
      ],
      failed: [],
    });
    expect(calls).toEqual([
      "settle",
      "provider codex",
      "provider claude-code",
      "plugin pool-usage",
      "plugin 1ma-auto-updates",
      "release",
    ]);
    expect(decisions).toEqual(["wait", "wait", "wait"]);
    expect(updates.decideDispatch()).toEqual({ action: "proceed" });
  });

  it("tells core to try a held message again soon, so it never waits on this plugin alone", async () => {
    let held: unknown = null;
    const { updates, advance } = setup({
      sleep: async () => {
        held = updates.decideDispatch();
      },
    });
    advance(QUIET_MS);
    await updates.run();
    expect(held).toEqual({
      action: "wait",
      reason: "held for updates",
      sendAt: 1_000_000 + QUIET_MS + 30_000,
    });
  });

  it.each([
    ["a turn is running", { status: "active", backgroundAgents: 0, workflows: 0 }],
    ["a turn is starting", { status: "starting", backgroundAgents: 0, workflows: 0 }],
    ["a background agent works", { status: "idle", backgroundAgents: 1, workflows: 0 }],
    ["a workflow runs", { status: "idle", backgroundAgents: 0, workflows: 1 }],
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
      .mockResolvedValueOnce([{ ...idle, status: "active" }]);
    const { updates, calls, advance } = setup({ threads });
    advance(QUIET_MS);
    expect(await updates.run()).toEqual({ kind: "busy" });
    expect(calls).toEqual(["settle", "release"]);
    expect(updates.decideDispatch()).toEqual({ action: "proceed" });
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
      kind: "updated",
      installed: ["claude-code on MacBook", "plugin 1ma-auto-updates"],
      failed: ["codex on MacBook", "plugin pool-usage"],
    });
    expect(deps.warn).toHaveBeenCalledWith("codex on MacBook: brew failed");
    expect(deps.warn).toHaveBeenCalledWith("plugin pool-usage: the update did not complete");
  });

  it("does nothing when both kinds of updates are turned off, and asks only for the kinds turned on", async () => {
    const off = setup({
      choices: async () => ({ providers: false, plugins: false }),
    });
    off.advance(QUIET_MS);
    expect(await off.updates.run()).toEqual({ kind: "off" });

    const findWork = vi.fn(async () => ({ providers: [], plugins: [] }));
    const providersOnly = setup({
      choices: async () => ({ providers: true, plugins: false }),
      findWork,
    });
    providersOnly.advance(QUIET_MS);
    expect(await providersOnly.updates.run()).toEqual({
      kind: "nothing-to-update",
    });
    expect(findWork).toHaveBeenCalledWith({ providers: true, plugins: false });
    expect(providersOnly.calls).toEqual([]);
  });

  it("stops holding messages after ten minutes, even while an install still runs", async () => {
    const install = deferred();
    let decisionLate: unknown = null;
    const state = setup({
      installProvider: async () => {
        state.advance(MAX_HOLD_MS);
        decisionLate = state.updates.decideDispatch();
        await install.promise;
        return true;
      },
    });
    state.advance(QUIET_MS);
    const pass = state.updates.run();
    await vi.waitFor(() => expect(decisionLate).not.toBeNull());
    expect(decisionLate).toEqual({ action: "proceed" });
    install.resolve();
    expect((await pass).kind).toBe("updated");
  });

  it("runs one pass at a time", async () => {
    const settle = deferred();
    const { updates, advance } = setup({ sleep: () => settle.promise });
    advance(QUIET_MS);
    const first = updates.run();
    await vi.waitFor(() => expect(updates.decideDispatch().action).toBe("wait"));
    expect(await updates.run()).toEqual({ kind: "in-progress" });
    settle.resolve();
    expect((await first).kind).toBe("updated");
  });
});
