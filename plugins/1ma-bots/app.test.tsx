// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { BotSummary } from "./src/contract.js";
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

async function threadRow(threadId: string, bots: BotSummary[]) {
  const app = await loadPluginApp(() => import("./app.js"));
  const registration = app.threadInfoRows.find((row) => row.id === "thread-bot")!;
  return renderSlot(
    registration,
    { threadId, projectId: "proj_1", environment: null },
    {
      pluginId: "1ma-bots",
      rpc: {
        "bots.v1.list": () => ({ bots }),
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
