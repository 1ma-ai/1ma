// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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
    expect(await screen.findByText(strings.dropFirst)).toBeTruthy();
    botDrop.cancel();
    await waitFor(() => expect(screen.queryByText(strings.dropFirst)).toBeNull());
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
