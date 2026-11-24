// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { BotDetail, BotSummary } from "./src/contract.js";
import { avatarDataUrl } from "./src/avatar.js";
import { parseCapabilities, parseRoute } from "./src/ui/bot-pages.js";
import { strings } from "./strings.js";

afterEach(cleanup);

const appearance = { shape: "circle", face: "calm", color: "#7c6cf0" } as const;

function bot(id: string, name: string, threads: BotSummary["threads"]): BotSummary {
  return {
    id,
    name,
    role: "",
    appearance,
    avatar: avatarDataUrl(appearance),
    capabilities: [],
    hidden: false,
    reach: null,
    threads,
  };
}

async function threadRow(threadId: string, bots: BotSummary[], detail?: BotDetail) {
  const app = await loadPluginApp(() => import("./app.js"));
  const registration = app.threadInfoRows.find((row) => row.id === "thread-bot")!;
  return renderSlot(
    registration,
    { threadId, projectId: "proj_1", environment: null },
    {
      pluginId: "1ma-bots",
      rpc: {
        "bots.v1.list": () => ({ bots }),
        "bots.v1.get": () => detail,
        "bots.v1.continueInBot": () => ({ threadId: "thr_continued" }),
      },
    },
  );
}

describe("the thread's bot row", () => {
  it("warns that a conversation bound later lacks other plugins' bot tools and offers to continue", async () => {
    const view = await threadRow("thr_old", [
      bot("bot_a", "Marketer", [{ threadId: "thr_old", startedFromBot: false, completed: false }]),
    ]);
    await screen.findByText(strings.threadBot.notStartedFromBot);
    fireEvent.click(screen.getByRole("button", { name: strings.threadBot.continueInBot }));
    await waitFor(() =>
      expect(view.inspection.navigateCalls).toContainEqual(
        expect.objectContaining({ threadId: "thr_continued" }),
      ),
    );
  });

  it("previews the instructions, memory and reachable peers contributed by this bot", async () => {
    const current = bot("bot_a", "Marketer", [
      { threadId: "thr_a", startedFromBot: true, completed: false },
    ]);
    const peer = bot("bot_b", "Analyst", []);
    const hidden = { ...bot("bot_c", "Hidden peer", []), hidden: true };
    await threadRow("thr_a", [current, peer, hidden], {
      ...current,
      instructions: "Write a short brief.",
      memory: "Use the approved glossary.",
      revision: 1,
      defaults: null,
      memorySha256: "",
    });
    fireEvent.click(await screen.findByRole("button", { name: strings.threadBot.preview }));
    const dialog = await screen.findByRole("dialog", {
      name: strings.threadBot.instructionsFrom("Marketer"),
    });
    await waitFor(() => expect(dialog.textContent).toContain("Write a short brief."));
    expect(dialog.textContent).toContain("Use the approved glossary.");
    expect(dialog.textContent).toContain("Analyst");
    expect(dialog.textContent).not.toContain("Hidden peer");
  });

  it("says nothing more for a conversation started from the bot", async () => {
    await threadRow("thr_new", [
      bot("bot_a", "Marketer", [{ threadId: "thr_new", startedFromBot: true, completed: false }]),
    ]);
    await screen.findByText("Marketer");
    expect(screen.queryByText(strings.threadBot.notStartedFromBot)).toBeNull();
  });
});

describe("bot page helpers", () => {
  it("work areas are trimmed, lower-cased and unique", () => {
    expect(parseCapabilities(" Dev, marketing ,dev,, Accounting")).toEqual([
      "dev",
      "marketing",
      "accounting",
    ]);
  });

  it("routes the list, a new bot, a bot and its new conversation", () => {
    expect(parseRoute("")).toEqual({ page: "list" });
    expect(parseRoute("new")).toEqual({ page: "new" });
    expect(parseRoute("bot_1")).toEqual({ page: "edit", botId: "bot_1" });
    expect(parseRoute("bot_1/chat")).toEqual({ page: "chat", botId: "bot_1" });
  });
});

describe("the bot page", () => {
  it("keeps unsaved edits when the bot changes elsewhere and says so", async () => {
    const app = await loadPluginApp(() => import("./app.js"));
    const panel = app.navPanels.find((item) => item.id === "bots")!;
    let detail = {
      ...bot("bot_1", "Marketer", []),
      instructions: "Write posts.",
      memory: "",
      memorySha256: "",
      defaults: null,
      revision: 1,
    };
    const view = renderSlot(panel, { subPath: "bot_1" } as never, {
      pluginId: "1ma-bots",
      rpc: {
        "bots.v1.get": () => detail,
        "bots.v1.list": () => ({ bots: [] }),
        "bots.v1.events": () => ({ events: [] }),
      },
    });
    const field = await screen.findByLabelText(strings.fields.instructions);
    fireEvent.change(field, { target: { value: "Write short posts." } });
    detail = { ...detail, memory: "- a fact", revision: 2 };
    await view.behavior.experimental_invalidateRpc(null);
    await screen.findByText(strings.changedElsewhere);
    expect(screen.getByLabelText<HTMLTextAreaElement>(strings.fields.instructions).value).toBe(
      "Write short posts.",
    );
  });
});

describe("Assign to bot in a thread's menu", () => {
  const thread = { id: "thr_1", parentThreadId: null, archivedAt: null } as never;

  it("offers every bot, marks the current one and can take the thread out", async () => {
    const { assignToBotAction } = await import("./src/ui/assign-action.js");
    const calls: Array<[string, string | null]> = [];
    const data = {
      bots: [
        bot("bot_a", "Marketer", [{ threadId: "thr_1", startedFromBot: false, completed: false }]),
        bot("bot_b", "Accountant", []),
      ],
      assign: async (threadId: string, botId: string | null) => {
        calls.push([threadId, botId]);
      },
    };
    const item = assignToBotAction.item({ thread, data } as never)!;
    expect(item.choices!.items.map((choice) => [choice.id, choice.selected ?? false])).toEqual([
      ["bot_a", true],
      ["bot_b", false],
      ["none", false],
    ]);
    await item.run({ value: "bot_b" } as never);
    await item.run({ value: "none" } as never);
    expect(calls).toEqual([
      ["thr_1", "bot_b"],
      ["thr_1", null],
    ]);
  });

  it("is absent for child conversations and when there are no bots", async () => {
    const { assignToBotAction } = await import("./src/ui/assign-action.js");
    const data = { bots: [bot("bot_a", "Marketer", [])], assign: async () => undefined };
    expect(
      assignToBotAction.item({
        thread: { id: "c", parentThreadId: "p", archivedAt: null },
        data,
      } as never),
    ).toBeNull();
    expect(assignToBotAction.item({ thread, data: { ...data, bots: [] } } as never)).toBeNull();
  });
});

describe("bot conversation menu", () => {
  const thread = { id: "thr_b", parentThreadId: null, archivedAt: null };
  const bots = [
    bot(
      "bot_a",
      "Editor",
      ["thr_a", "thr_b", "thr_c"].map((threadId) => ({
        threadId,
        completed: threadId === "thr_b",
        startedFromBot: true,
      })),
    ),
  ];
  it("moves the selected conversation ahead of the others without changing completion", async () => {
    const app = await loadPluginApp(() => import("./app.js"));
    const move = app.threadActions.find((action) => action.id === "move-to-top")!;
    const mutate = vi.fn();
    const action = move.item({ thread, data: { bots, reorder: { mutate } } } as never)!;
    await action.run({} as never);
    expect(mutate).toHaveBeenCalledExactlyOnceWith({
      botId: "bot_a",
      threadIds: ["thr_b", "thr_a", "thr_c"],
    });
    expect(
      move.item({ thread: { ...thread, id: "thr_project" }, data: { bots } } as never),
    ).toBeNull();
  });
  it("offers Move to top for a sub-chat too, and not where it already stands first", async () => {
    const app = await loadPluginApp(() => import("./app.js"));
    const move = app.threadActions.find((action) => action.id === "move-to-top")!;
    const item = (id: string) =>
      move.item({
        thread: { ...thread, id, parentThreadId: "thr_a" },
        data: { bots, reorder: { mutate: vi.fn() } },
      } as never)!;
    expect(item("thr_c").disabled).toBe(false);
    expect(item("thr_a").disabled).toBe(true);
  });
  it("reopens a completed conversation from the same menu", async () => {
    const app = await loadPluginApp(() => import("./app.js"));
    const toggle = app.threadActions.find((action) => action.id === "toggle-done")!;
    const mutate = vi.fn();
    const action = toggle.item({
      thread,
      data: { bots, threads: [], setCompleted: { mutate } },
    } as never)!;
    expect(action.label).toBe(strings.threadBot.markNotDone);
    await action.run({} as never);
    expect(mutate).toHaveBeenCalledExactlyOnceWith({ threadId: thread.id, completed: false });
    expect(
      toggle.item({ thread: { ...thread, id: "thr_project" }, data: { bots } } as never),
    ).toBeNull();
  });
  it("says Not done for a sub-chat that is done with the conversation above it", async () => {
    const app = await loadPluginApp(() => import("./app.js"));
    const toggle = app.threadActions.find((action) => action.id === "toggle-done")!;
    const mutate = vi.fn();
    const guestOwner = bot("bot_g", "Guest", [
      { threadId: "thr_guest", startedFromBot: true, completed: false },
    ]);
    const item = (id: string) =>
      toggle.item({
        thread: { id, archivedAt: null },
        data: {
          bots: [...bots, guestOwner],
          threads: [
            { id: "thr_c", parentThreadId: "thr_spawned" },
            { id: "thr_spawned", parentThreadId: "thr_b" },
            { id: "thr_guest", parentThreadId: "thr_b" },
            { id: "thr_a", parentThreadId: null },
          ],
          setCompleted: { mutate },
        },
      } as never)!;
    expect(item("thr_c").label).toBe(strings.threadBot.markNotDone);
    await item("thr_c").run({} as never);
    expect(mutate).toHaveBeenCalledExactlyOnceWith({ threadId: "thr_c", completed: false });
    expect(item("thr_guest").label).toBe(strings.threadBot.markDone);
    expect(item("thr_a").label).toBe(strings.threadBot.markDone);
  });
});
