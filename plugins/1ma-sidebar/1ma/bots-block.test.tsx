// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
// jsdom draws nothing, so it has no scrollIntoView; the block calls it after a drop.
Element.prototype.scrollIntoView = vi.fn();
vi.mock("sonner", () => ({ toast: toasts }));
import type { ExperimentalSidebarNavigationItem } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { makePluginProject, makeSidebarThread } from "../app/model/fixtures.js";
import { resetPreferencesSyncForTest } from "../app/preferences/preferences-sync.js";
import { defaultPreferences } from "../shared/preferences.js";
import type { SidebarBot } from "./bots-rpc.js";
import { botDrop } from "./thread-drop.js";
import { strings } from "./strings.js";

const app = await loadPluginApp(() => import("../app"));
const registration = app.threadLists[0]!;

const PROJECTS = [makePluginProject({ id: "proj_app", name: "App" })];
const THREADS = [
  makeSidebarThread({ id: "thr_bot", projectId: "proj_app", title: "Creatives", createdAt: 3 }),
  makeSidebarThread({
    id: "thr_bot_child",
    projectId: "proj_app",
    title: "Banner draft",
    parentThreadId: "thr_bot",
    createdAt: 2,
  }),
  makeSidebarThread({ id: "thr_plain", projectId: "proj_app", title: "Plain chat", createdAt: 1 }),
];
const BOTS_PANEL = {
  id: "plugin:1ma-bots:bots",
  label: "Bots",
  icon: { kind: "plugin" },
  action: { kind: "open-plugin-panel", pluginId: "1ma-bots", panelId: "bots" },
  isDisabled: false,
  isVisible: true,
  isLoading: false,
  pluginId: "1ma-bots",
  shortcut: null,
} as unknown as ExperimentalSidebarNavigationItem;

function marketer(hidden = false): SidebarBot {
  return {
    id: "bot_m",
    name: "Marketer",
    role: "Landing pages",
    avatar: "data:image/svg+xml;utf8,<svg/>",
    hidden,
    threads: [{ threadId: "thr_bot", startedFromBot: true, completed: false }],
  };
}

function render(options: {
  bots?: () => { bots: SidebarBot[] };
  botsInstalled?: boolean;
  settings?: Record<string, boolean>;
  setPreference?: (input: unknown) => unknown;
  setHidden?: (input: unknown) => unknown;
  assign?: (input: unknown) => unknown;
  threads?: typeof THREADS;
}) {
  return renderSlot(
    registration,
    {
      activeThreadId: null,
      activeProjectId: null,
      isCompactViewport: false,
      onNavigate: vi.fn(),
      searchQuery: "",
    },
    {
      sidebarThreads: { projects: PROJECTS, sections: [], threads: options.threads ?? THREADS },
      sidebarNavigation: { items: options.botsInstalled === false ? [] : [BOTS_PANEL] },
      settings: options.settings,
      rpc: {
        listPreferences: () => ({ preferences: defaultPreferences() }),
        setPreference: options.setPreference ?? ((input: unknown) => input),
        "bots.v1.list": options.bots ?? (() => ({ bots: [] })),
        "bots.v1.setHidden": options.setHidden ?? (() => ({ ok: true })),
        "bots.v1.assign": options.assign ?? (() => ({ botId: "bot_m", startedFromBot: false })),
      },
    },
  );
}

function threadIdsInList(): string[] {
  return Array.from(document.querySelectorAll("[data-sidebar-thread-id]"), (element) =>
    element.getAttribute("data-sidebar-thread-id"),
  ).filter((id): id is string => id !== null);
}

function botElement(botId: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(`[data-bot-id="${botId}"]`);
  if (element === null) throw new Error(`no bot ${botId}`);
  return element;
}

function threadIdsIn(element: HTMLElement): string[] {
  return Array.from(element.querySelectorAll("a[data-sidebar-thread-id]"), (link) =>
    link.getAttribute("data-sidebar-thread-id"),
  ).filter((id): id is string => id !== null);
}

afterEach(() => {
  cleanup();
  resetPreferencesSyncForTest();
});

describe("the bots block", () => {
  it("shows a bot above the projects and its conversations only under it", async () => {
    render({ bots: () => ({ bots: [marketer()] }) });
    await screen.findByText("Marketer");
    await screen.findByText("Plain chat");
    const bot = botElement("bot_m");
    expect(threadIdsIn(bot)).toEqual(["thr_bot", "thr_bot_child"]);
    expect(threadIdsInList().filter((id) => id === "thr_bot")).toHaveLength(1);
    expect(threadIdsInList().filter((id) => id === "thr_bot_child")).toHaveLength(1);
    const bots = screen.getByText("Marketer");
    const plain = screen.getByText("Plain chat");
    expect(bots.compareDocumentPosition(plain) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("without 1ma Bots the list is bb's own", async () => {
    render({ botsInstalled: false, bots: () => ({ bots: [marketer()] }) });
    await screen.findByText("Creatives");
    expect(screen.queryByText(strings.title)).toBeNull();
    expect(screen.queryByText("Marketer")).toBeNull();
  });

  it("turned off in settings, the list is bb's own", async () => {
    render({ settings: { showBots: false }, bots: () => ({ bots: [marketer()] }) });
    await screen.findByText("Creatives");
    expect(screen.queryByText("Marketer")).toBeNull();
  });

  it("a hidden bot's conversations stay in their project", async () => {
    render({ bots: () => ({ bots: [marketer(true)] }) });
    await screen.findByText("Creatives");
    expect(screen.queryByText("Marketer")).toBeNull();
  });

  it("when bots cannot be read, it says so and the projects show every conversation", async () => {
    render({
      bots: () => {
        throw new Error("1ma-bots is reloading");
      },
    });
    await screen.findByText(strings.unavailable);
    await screen.findByText("Creatives");
    await screen.findByText("Banner draft");
  });
});

describe("Codex review of stage 2: a bot with only done conversations", () => {
  it("still opens its list, and Done reaches the conversation", async () => {
    render({
      bots: () => ({
        bots: [
          {
            ...marketer(),
            threads: [{ threadId: "thr_bot", startedFromBot: true, completed: true }],
          },
        ],
      }),
    });
    await screen.findByText("Marketer");
    expect(threadIdsIn(botElement("bot_m"))).toEqual([]);
    fireEvent.click(await screen.findByText(strings.done(1)));
    expect(threadIdsIn(botElement("bot_m"))).toEqual(["thr_bot", "thr_bot_child"]);
  });
});

describe("a done conversation that is working again", () => {
  it("shows with the open conversations while it runs", async () => {
    const running = THREADS.map((thread) =>
      thread.id === "thr_bot" ? { ...thread, status: "active" as const } : thread,
    );
    renderSlot(
      registration,
      {
        activeThreadId: null,
        activeProjectId: null,
        isCompactViewport: false,
        onNavigate: vi.fn(),
        searchQuery: "",
      },
      {
        sidebarThreads: { projects: PROJECTS, sections: [], threads: running },
        sidebarNavigation: { items: [BOTS_PANEL] },
        rpc: {
          listPreferences: () => ({ preferences: defaultPreferences() }),
          setPreference: (input: unknown) => input,
          "bots.v1.list": () => ({
            bots: [
              {
                ...marketer(),
                threads: [{ threadId: "thr_bot", startedFromBot: true, completed: true }],
              },
            ],
          }),
        },
      },
    );
    await screen.findByText("Marketer");
    expect(threadIdsIn(botElement("bot_m"))).toEqual(["thr_bot", "thr_bot_child"]);
    expect(screen.queryByText(strings.done(1))).toBeNull();
  });
});

describe("the owner's review of the bots block: a bot is drawn like a parent thread", () => {
  it("the chevron after the name collapses the conversations, and the choice is kept", async () => {
    const writes: unknown[] = [];
    render({
      bots: () => ({ bots: [marketer()] }),
      setPreference: (input) => {
        writes.push(input);
        return input;
      },
    });
    await screen.findByText("Marketer");
    fireEvent.click(screen.getByRole("button", { name: strings.collapse("Marketer") }));
    expect(threadIdsIn(botElement("bot_m"))).toEqual([]);
    await waitFor(() =>
      expect(writes).toContainEqual(
        expect.objectContaining({ key: "collapsedBots", value: ["bot_m"] }),
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: strings.expand("Marketer") }));
    expect(threadIdsIn(botElement("bot_m"))).toEqual(["thr_bot", "thr_bot_child"]);
  });

  it("under the name it shows the bot's role, as Bots Sidebar does", async () => {
    render({ bots: () => ({ bots: [marketer()] }) });
    await screen.findByText("Marketer");
    const role = botElement("bot_m").querySelector("[data-1ma-bot-role]");
    expect(role?.textContent).toBe("Landing pages");
  });

  it("offers a new conversation with the stock new-thread button on the bot's row", async () => {
    render({ bots: () => ({ bots: [marketer()] }) });
    await screen.findByText("Marketer");
    fireEvent.click(screen.getByRole("button", { name: strings.newConversation("Marketer") }));
    await screen.findByRole("dialog");
  });
});

async function openBotMenu(name: string) {
  fireEvent.keyDown(screen.getByRole("button", { name: strings.botActions(name) }), {
    key: "Enter",
  });
  await screen.findByRole("menuitem", { name: strings.botSettings });
}

describe("the owner's review of 17.11: hiding a bot and its state at a glance", () => {
  it("Hide bot in the bot's menu hides it, and the hidden line brings it back", async () => {
    const calls: unknown[] = [];
    let bots = [marketer()];
    render({
      bots: () => ({ bots }),
      setHidden: (input) => {
        calls.push(input);
        return { ok: true };
      },
    });
    await screen.findByText("Marketer");
    await openBotMenu("Marketer");
    fireEvent.click(screen.getByRole("menuitem", { name: strings.hideBot }));
    await waitFor(() => expect(calls).toEqual([{ botId: "bot_m", hidden: true }]));
    cleanup();
    resetPreferencesSyncForTest();
    bots = [marketer(true)];
    render({
      bots: () => ({ bots }),
      setHidden: (input) => {
        calls.push(input);
        return { ok: true };
      },
    });
    fireEvent.click(await screen.findByText(strings.hiddenBots(1)));
    const row = await screen.findByText("Marketer");
    expect(row.closest("[data-1ma-bot-hidden]")).not.toBeNull();
    expect(threadIdsIn(botElement("bot_m"))).toEqual([]);
    await openBotMenu("Marketer");
    fireEvent.click(screen.getByRole("menuitem", { name: strings.showBot }));
    await waitFor(() => expect(calls).toContainEqual({ botId: "bot_m", hidden: false }));
  });

  it("the avatar shows the main conversation's state, dots for others working, and a failure elsewhere", async () => {
    const extra = [1, 2, 3, 4].map((n) =>
      makeSidebarThread({
        id: `thr_w${n}`,
        projectId: "proj_app",
        title: `Working ${n}`,
        createdAt: 10 + n,
        status: "active",
        runtimeStatus: "active",
      }),
    );
    const failed = makeSidebarThread({
      id: "thr_failed",
      projectId: "proj_app",
      title: "Failed",
      createdAt: 20,
      status: "error",
    });
    const main = makeSidebarThread({
      id: "thr_main",
      projectId: "proj_app",
      title: "Main",
      createdAt: 30,
      status: "active",
      runtimeStatus: "active",
    });
    const items = [main, ...extra, failed];
    render({
      threads: [...THREADS, ...items],
      bots: () => ({
        bots: [
          {
            ...marketer(),
            threads: items.map((thread) => ({
              threadId: thread.id,
              startedFromBot: true,
              completed: false,
            })),
          },
        ],
      }),
    });
    await screen.findByText("Marketer");
    const avatar = botElement("bot_m").querySelector("[data-1ma-bot-avatar]")!;
    expect(avatar.querySelector("[data-1ma-bot-main-status]")).not.toBeNull();
    expect(avatar.querySelectorAll("[data-1ma-bot-other-working]")).toHaveLength(2);
    expect(avatar.querySelector("[data-1ma-bot-other-working-more]")).not.toBeNull();
    expect(avatar.querySelector("[data-1ma-bot-unread-error]")).not.toBeNull();
    expect(avatar.getAttribute("title")).toContain(strings.othersWorking(4));
  });
});

describe("dragging conversations onto a bot", () => {
  it("drops on the face as first, keeping the dragged order, and on the row as last", async () => {
    const calls: unknown[] = [];
    render({
      bots: () => ({ bots: [marketer()] }),
      assign: (input) => {
        calls.push(input);
        return { botId: "bot_m", startedFromBot: false };
      },
    });
    await screen.findByText("Marketer");
    const row = botElement("bot_m");
    const face = row.querySelector("[data-1ma-bot-avatar]")!;
    face.getBoundingClientRect = () => new DOMRect(0, 0, 32, 32);
    // As in the browser, hit testing finds the row's click target, not the face.
    const target = row.querySelector("button")!;
    document.elementsFromPoint = () => [target];
    botDrop.start(["thr_plain", "thr_other"]);
    expect(botDrop.over({ x: 10, y: 10 })).toBe(true);
    botDrop.end();
    await waitFor(() => expect(calls).toHaveLength(2));
    botDrop.start(["thr_last"]);
    botDrop.over({ x: 100, y: 10 });
    botDrop.end();
    await waitFor(() => expect(calls).toHaveLength(3));
    expect(calls).toEqual([
      { threadId: "thr_other", botId: "bot_m", place: "first" },
      { threadId: "thr_plain", botId: "bot_m", place: "first" },
      { threadId: "thr_last", botId: "bot_m", place: "last" },
    ]);
  });

  it("shows where the drop lands while the pointer is over the bot", async () => {
    render({ bots: () => ({ bots: [marketer()] }) });
    await screen.findByText("Marketer");
    const row = botElement("bot_m");
    row.querySelector("[data-1ma-bot-avatar]")!.getBoundingClientRect = () =>
      new DOMRect(0, 0, 32, 32);
    document.elementsFromPoint = () => [row.querySelector("button")!];
    botDrop.start(["thr_plain"]);
    botDrop.over({ x: 10, y: 10 });
    expect(await screen.findByText(strings.dropFirst(1))).toBeTruthy();
    botDrop.cancel();
    await waitFor(() => expect(screen.queryByText(strings.dropFirst(1))).toBeNull());
  });
});

describe("dragging a selection that holds a sub-thread onto a bot", () => {
  it("moves the top-level conversations and leaves the sub-thread to follow its parent", async () => {
    const calls: unknown[] = [];
    render({
      bots: () => ({ bots: [{ ...marketer(), threads: [] }] }),
      assign: (input) => {
        calls.push(input);
        return { botId: "bot_m", startedFromBot: false };
      },
    });
    await screen.findByText("Marketer");
    const row = botElement("bot_m");
    document.elementsFromPoint = () => [row.querySelector("button")!];
    botDrop.start(["thr_bot", "thr_bot_child", "thr_plain"]);
    botDrop.over({ x: 100, y: 10 });
    botDrop.end();
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls).toEqual([
      { threadId: "thr_bot", botId: "bot_m", place: "last" },
      { threadId: "thr_plain", botId: "bot_m", place: "last" },
    ]);
  });
});

// A server for the drop tests: it keeps the bot's order the way 1ma-bots
// binds a conversation (moved out, then put first or last), and shows it in
// bots.v1.list.
function dropServer(options: {
  saveThenLose?: number;
  refuse?: number;
  listFails?: () => boolean;
  owned?: string[];
  // Another client assigns this conversation to the bot after a call fails
  // and before the bot is read again.
  othersAssign?: { threadId: string; place: "first" | "last" };
}) {
  const owned: string[] = [...(options.owned ?? [])];
  let call = 0;
  let failed = false;
  const bind = (threadId: string, place: "first" | "last" | undefined) => {
    const at = owned.indexOf(threadId);
    if (at !== -1) owned.splice(at, 1);
    if (place === "first") owned.unshift(threadId);
    else owned.push(threadId);
  };
  return {
    owned,
    bots: () => {
      if (options.listFails?.()) throw new Error("1ma-bots is restarting");
      if (failed && options.othersAssign !== undefined) {
        bind(options.othersAssign.threadId, options.othersAssign.place);
        options.othersAssign = undefined;
      }
      return {
        bots: [
          {
            ...marketer(),
            threads: owned.map((threadId) => ({
              threadId,
              startedFromBot: false,
              completed: false,
            })),
          },
        ],
      };
    },
    assign: (input: unknown) => {
      call += 1;
      const { threadId, place } = input as { threadId: string; place?: "first" | "last" };
      if (call === options.refuse) {
        failed = true;
        throw new Error("That conversation was archived");
      }
      bind(threadId, place);
      if (call === options.saveThenLose) {
        failed = true;
        throw new Error("The answer did not arrive");
      }
      return { botId: "bot_m", startedFromBot: false };
    },
  };
}

async function dropTwo(threadIds = ["thr_bot", "thr_plain"], x = 100) {
  await screen.findByText("Marketer");
  const row = botElement("bot_m");
  row.querySelector("[data-1ma-bot-avatar]")!.getBoundingClientRect = () =>
    new DOMRect(0, 0, 32, 32);
  document.elementsFromPoint = () => [row.querySelector("button")!];
  botDrop.start(threadIds);
  botDrop.over({ x, y: 10 });
  botDrop.end();
}

describe("Codex review of f6aa64f: a drop that fails partway", () => {
  it("says how many moved and offers to open the moved conversation", async () => {
    toasts.error.mockClear();
    toasts.success.mockClear();
    const server = dropServer({ refuse: 2 });
    render({ bots: server.bots, assign: server.assign });
    await dropTwo();
    await waitFor(() => expect(toasts.error).toHaveBeenCalled());
    const [title, options] = toasts.error.mock.calls[0]!;
    expect(title).toBe(strings.partlyAssigned("Marketer", 1, 2));
    expect(options).toMatchObject({
      description: expect.stringContaining("archived"),
      action: { label: strings.open },
    });
    expect(toasts.success).not.toHaveBeenCalled();
  });
});

describe("Codex review of d2c3da0: an assignment whose answer is lost", () => {
  it("reads the bot again and reports what the server actually saved", async () => {
    toasts.error.mockClear();
    toasts.success.mockClear();
    const server = dropServer({ saveThenLose: 2 });
    render({ bots: server.bots, assign: server.assign });
    await dropTwo();
    await waitFor(() => expect(toasts.success).toHaveBeenCalled());
    expect(toasts.success.mock.calls[0]![0]).toBe(strings.assigned("Marketer", 2));
    expect(toasts.error).not.toHaveBeenCalled();
  });

  it("does not claim the rest stayed when the bot cannot be read again either", async () => {
    toasts.error.mockClear();
    toasts.success.mockClear();
    let dropped = false;
    const server = dropServer({ saveThenLose: 2, listFails: () => dropped });
    render({
      bots: server.bots,
      assign: (input) => {
        dropped = true;
        return server.assign(input);
      },
    });
    await dropTwo();
    await waitFor(() => expect(toasts.error).toHaveBeenCalled());
    const [title] = toasts.error.mock.calls[0]!;
    expect(title).toBe(strings.unconfirmedAssigned("Marketer", 1, 2));
    expect(title).not.toBe(strings.partlyAssigned("Marketer", 1, 2));
  });
});

describe("Codex review of 98142c5: a drop that reorders a bot's own conversations", () => {
  it("does not report success when the first move is refused and the order stays", async () => {
    toasts.error.mockClear();
    toasts.success.mockClear();
    const server = dropServer({ refuse: 1, owned: ["keep", "thr_bot", "thr_plain"] });
    render({ bots: server.bots, assign: server.assign });
    await dropTwo(["thr_bot", "thr_plain"], 10);
    await waitFor(() => expect(toasts.error).toHaveBeenCalled());
    expect(toasts.success).not.toHaveBeenCalled();
    expect(toasts.error.mock.calls[0]![0]).toBe(strings.unconfirmedAssigned("Marketer", 0, 2));
    expect(server.owned).toEqual(["keep", "thr_bot", "thr_plain"]);
  });

  it("reports success when the lost answer's move is in the bot's order after all", async () => {
    toasts.error.mockClear();
    toasts.success.mockClear();
    const server = dropServer({ saveThenLose: 2, owned: ["keep", "thr_bot", "thr_plain"] });
    render({ bots: server.bots, assign: server.assign });
    await dropTwo(["thr_bot", "thr_plain"], 10);
    await waitFor(() => expect(toasts.success).toHaveBeenCalled());
    expect(toasts.success.mock.calls[0]![0]).toBe(strings.assigned("Marketer", 2));
    expect(server.owned).toEqual(["thr_bot", "thr_plain", "keep"]);
  });
});

describe("Codex review of 7be99a2: another conversation placed on the bot before it is read again", () => {
  const other = { threadId: "thr_other", place: "last" } as const;

  it("counts a conversation from a project as moved when the bot has it, wherever it stands", async () => {
    toasts.error.mockClear();
    toasts.success.mockClear();
    const server = dropServer({ saveThenLose: 2, owned: ["keep"], othersAssign: other });
    render({ bots: server.bots, assign: server.assign });
    await dropTwo();
    await waitFor(() => expect(toasts.success).toHaveBeenCalled());
    expect(toasts.success.mock.calls[0]![0]).toBe(strings.assigned("Marketer", 2));
    expect(toasts.error).not.toHaveBeenCalled();
    expect(server.owned).toEqual(["keep", "thr_bot", "thr_plain", "thr_other"]);
  });

  it("still says the rest stayed when the call was refused", async () => {
    toasts.error.mockClear();
    toasts.success.mockClear();
    const server = dropServer({ refuse: 2, owned: ["keep"], othersAssign: other });
    render({ bots: server.bots, assign: server.assign });
    await dropTwo();
    await waitFor(() => expect(toasts.error).toHaveBeenCalled());
    expect(toasts.error.mock.calls[0]![0]).toBe(strings.partlyAssigned("Marketer", 1, 2));
    expect(toasts.success).not.toHaveBeenCalled();
    expect(server.owned).toEqual(["keep", "thr_bot", "thr_other"]);
  });

  it("does not claim a reorder failed when another conversation took the place it was put in", async () => {
    toasts.error.mockClear();
    toasts.success.mockClear();
    const server = dropServer({
      saveThenLose: 2,
      owned: ["keep", "thr_bot", "thr_plain"],
      othersAssign: { threadId: "thr_other", place: "first" },
    });
    render({ bots: server.bots, assign: server.assign });
    await dropTwo(["thr_bot", "thr_plain"], 10);
    await waitFor(() => expect(toasts.error).toHaveBeenCalled());
    expect(toasts.error.mock.calls[0]![0]).toBe(strings.unconfirmedAssigned("Marketer", 1, 2));
    expect(toasts.success).not.toHaveBeenCalled();
    expect(server.owned).toEqual(["thr_other", "thr_bot", "thr_plain", "keep"]);
  });
});
