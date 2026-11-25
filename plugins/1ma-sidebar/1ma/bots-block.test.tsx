// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
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
const { useMainThread } = await import("./BotsBlock.js");
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
  bots?: () => { bots: SidebarBot[] } | Promise<{ bots: SidebarBot[] }>;
  botsInstalled?: boolean;
  settings?: Record<string, boolean>;
  setPreference?: (input: unknown) => unknown;
  setHidden?: (input: unknown) => unknown;
  assign?: (input: unknown) => unknown;
  main?: () => { threadId: string | null };
  threads?: typeof THREADS;
  preferences?: Partial<ReturnType<typeof defaultPreferences>>;
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
        listPreferences: () => ({
          preferences: { ...defaultPreferences(), ...options.preferences },
        }),
        setPreference: options.setPreference ?? ((input: unknown) => input),
        "bots.v1.list": options.bots ?? (() => ({ bots: [] })),
        "bots.v1.main": options.main ?? (() => ({ threadId: null })),
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

  it("is not drawn until the first bot exists, and appears with it", async () => {
    let bots: SidebarBot[] = [];
    const view = render({ bots: () => ({ bots }) });
    await screen.findByText("Creatives");
    expect(document.querySelector("[data-1ma-bots-block]")).toBeNull();
    expect(screen.queryByText(strings.title)).toBeNull();
    expect(screen.queryByRole("button", { name: strings.newBot })).toBeNull();
    bots = [marketer()];
    await view.behavior.experimental_invalidateRpc(null, "1ma-bots");
    await screen.findByText("Marketer");
    expect(document.querySelector("[data-1ma-bots-block]")).not.toBeNull();
    bots = [];
    await view.behavior.experimental_invalidateRpc(null, "1ma-bots");
    await waitFor(() => expect(document.querySelector("[data-1ma-bots-block]")).toBeNull());
    expect(threadIdsInList()).toContain("thr_bot");
  });

  it("collapsed, it still says when the bots cannot be read", async () => {
    let bots: SidebarBot[] = [marketer()];
    let fail = false;
    const view = render({
      preferences: { collapsedBots: ["bots"] },
      bots: () => {
        if (fail) throw new Error("1ma-bots is reloading");
        return { bots };
      },
    });
    await waitFor(() => expect(document.querySelector("[data-1ma-bots-block]")).not.toBeNull());
    expect(screen.queryByText("Marketer")).toBeNull();
    bots = [];
    await view.behavior.experimental_invalidateRpc(null, "1ma-bots");
    await waitFor(() => expect(document.querySelector("[data-1ma-bots-block]")).toBeNull());
    fail = true;
    await view.behavior.experimental_invalidateRpc(null, "1ma-bots");
    await screen.findByText(strings.unavailable);
    expect(threadIdsInList()).toContain("thr_bot");
    fail = false;
    bots = [marketer()];
    await view.behavior.experimental_invalidateRpc(null, "1ma-bots");
    await waitFor(() => expect(screen.queryByText(strings.unavailable)).toBeNull());
    expect(screen.queryByText("Marketer")).toBeNull();
  });

  it("draws nothing while it is not yet known whether there is a bot", async () => {
    render({ bots: () => new Promise<never>(() => undefined) });
    await screen.findByText("Creatives");
    expect(document.querySelector("[data-1ma-bots-block]")).toBeNull();
  });

  it("with only hidden bots it stays, so they can be shown again", async () => {
    render({ bots: () => ({ bots: [marketer(true)] }) });
    await screen.findByText(strings.hiddenBots(1));
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
          "bots.v1.main": () => ({ threadId: "thr_bot" }),
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

describe("a click on a bot", () => {
  const open = () =>
    fireEvent.click(screen.getByRole("button", { name: strings.openBot("Marketer") }));

  it("opens the conversation 1ma Bots names at that moment", async () => {
    let main = "thr_bot";
    const view = render({
      bots: () => ({ bots: [marketer()] }),
      main: () => ({ threadId: main }),
    });
    await screen.findByText("Marketer");
    main = "thr_plain";
    open();
    await waitFor(() =>
      expect(view.inspection.navigateCalls).toContainEqual(
        expect.objectContaining({ threadId: "thr_plain" }),
      ),
    );
    expect(view.inspection.navigateCalls).toHaveLength(1);
  });

  it("offers a new conversation when the bot has no open one", async () => {
    const view = render({ bots: () => ({ bots: [marketer()] }) });
    await screen.findByText("Marketer");
    open();
    await screen.findByRole("dialog", { name: strings.newConversation("Marketer") });
    expect(view.inspection.navigateCalls).toEqual([]);
  });

  it("says why it could not open", async () => {
    const view = render({
      bots: () => ({ bots: [marketer()] }),
      main: () => {
        throw new Error("1ma-bots is reloading");
      },
    });
    await screen.findByText("Marketer");
    open();
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith("1ma-bots is reloading"));
    expect(view.inspection.navigateCalls).toEqual([]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("the avatar's main conversation is read again when a conversation starts working", async () => {
    let main = "thr_bot";
    function Probe() {
      const [status, setStatus] = useState<"idle" | "active">("idle");
      const open = [THREADS[0]!, { ...THREADS[2]!, status }];
      const thread = useMainThread(marketer(), { open, done: [] });
      return <button onClick={() => setStatus("active")}>{thread?.id ?? "none"}</button>;
    }
    renderSlot({ component: Probe as never }, {} as never, {
      rpc: { "bots.v1.main": () => ({ threadId: main }) },
    });
    const button = await screen.findByText("thr_bot");
    main = "thr_plain";
    fireEvent.click(button);
    await screen.findByText("thr_plain");
  });

  it("the avatar's main conversation is read again when a conversation changes during the first reading", async () => {
    let answerFirst = () => {};
    let reads = 0;
    function Probe() {
      const [status, setStatus] = useState<"idle" | "active">("idle");
      const open = [THREADS[0]!, { ...THREADS[2]!, status }];
      const thread = useMainThread(marketer(), { open, done: [] });
      return (
        <button onClick={() => setStatus("active")}>
          {status}: {thread?.id ?? "none"}
        </button>
      );
    }
    renderSlot({ component: Probe as never }, {} as never, {
      rpc: {
        "bots.v1.main": async () => {
          reads += 1;
          if (reads > 1) return { threadId: "thr_plain" };
          await new Promise<void>((resolve) => (answerFirst = resolve));
          return { threadId: "thr_bot" };
        },
      },
    });
    const button = screen.getByRole("button");
    await waitFor(() => expect(reads).toBe(1));
    fireEvent.click(button);
    await waitFor(() => expect(button.textContent).toBe("active: none"));
    answerFirst();
    await waitFor(() => expect(button.textContent).toBe("active: thr_plain"));
    expect(reads).toBe(2);
  });
});

describe("nested conversations of a bot", () => {
  const nested = (
    id: string,
    parentThreadId: string | null = null,
    extra: Parameters<typeof makeSidebarThread>[0] = {},
  ) => makeSidebarThread({ id, projectId: "proj_app", title: id, parentThreadId, ...extra });
  // thr_spawned has no place of its own in the bot; it is newer than its siblings.
  const TREE = [
    nested("thr_second", "thr_parent", { createdAt: 1 }),
    nested("thr_spawned", "thr_parent", { createdAt: 9 }),
    nested("thr_first", "thr_parent", { createdAt: 2 }),
    nested("thr_parent"),
    nested("thr_main"),
  ];
  const memberOrder = ["thr_second", "thr_main", "thr_parent", "thr_first"];
  const withDone = (done: string[], order = memberOrder): SidebarBot => ({
    ...marketer(),
    threads: order.map((threadId) => ({
      threadId,
      startedFromBot: true,
      completed: done.includes(threadId),
    })),
  });
  const changed = (id: string, extra: Parameters<typeof makeSidebarThread>[0]) =>
    TREE.map((thread) => (thread.id === id ? { ...thread, ...extra } : thread) as typeof thread);
  async function rows(done: string[], threads = TREE) {
    const view = render({ bots: () => ({ bots: [withDone(done)] }), threads });
    await screen.findByText("Marketer");
    const open = threadIdsIn(botElement("bot_m"));
    const count = screen.queryByText(/^Done: /u)?.textContent ?? null;
    return { view, open, count };
  }

  it("stand in the bot's order inside their parent, sub-threads without a place after them", async () => {
    expect((await rows([])).open).toEqual([
      "thr_main",
      "thr_parent",
      "thr_second",
      "thr_first",
      "thr_spawned",
    ]);
  });

  it("a parent goes to Done with its whole branch, counted once", async () => {
    const { open, count } = await rows(["thr_parent", "thr_first"]);
    expect(open).toEqual(["thr_main"]);
    expect(count).toBe(strings.done(1));
    fireEvent.click(screen.getByText(strings.done(1)));
    expect(threadIdsIn(botElement("bot_m"))).toEqual([
      "thr_main",
      "thr_parent",
      "thr_second",
      "thr_first",
      "thr_spawned",
    ]);
  });

  it("a done sub-chat leaves its open parent and is counted on its own", async () => {
    const { open, count } = await rows(["thr_first"]);
    expect(open).toEqual(["thr_main", "thr_parent", "thr_second", "thr_spawned"]);
    expect(count).toBe(strings.done(1));
  });

  it.each([
    ["runs", { status: "active" as const }],
    ["has a question", { hasPendingInteraction: true }],
    ["failed", { status: "error" as const }],
    ["has a failed queue", { queuedWork: "failed" as const }],
  ])("a branch whose sub-thread %s stays in sight whole", async (_state, extra) => {
    const { open, count } = await rows(["thr_parent"], changed("thr_spawned", extra));
    expect(open).toEqual(["thr_main", "thr_parent", "thr_second", "thr_first", "thr_spawned"]);
    expect(count).toBeNull();
  });

  it("a sub-chat marked done on its own stays done while its sibling runs", async () => {
    const { open, count } = await rows(
      ["thr_parent", "thr_first"],
      changed("thr_spawned", { status: "active" }),
    );
    expect(open).toEqual(["thr_main", "thr_parent", "thr_second", "thr_spawned"]);
    expect(count).toBe(strings.done(1));
  });

  it("a restored sub-thread stands at the top beside its archived parent", async () => {
    const threads = [
      ...changed("thr_parent", { isArchived: true }),
      nested("thr_low", "thr_first"),
    ];
    render({
      bots: () => ({ bots: [withDone(["thr_parent", "thr_first"])] }),
      threads,
    });
    await screen.findByText("Marketer");
    // The tree ends at the archived parent: its mark is not thr_second's, and
    // thr_first counts beside it.
    expect(threadIdsIn(botElement("bot_m"))).toContain("thr_second");
    expect(screen.getByText(/^Done: /u).textContent).toBe(strings.done(2));
  });

  it("a hidden helper thread neither counts nor keeps its branch open", async () => {
    const { open, count } = await rows(
      ["thr_parent"],
      changed("thr_spawned", { isHidden: true, status: "error" }),
    );
    expect(open).toEqual(["thr_main"]);
    expect(count).toBe(strings.done(1));
  });

  it("a conversation of another bot inside the branch keeps its own place", async () => {
    render({
      bots: () => ({
        bots: [
          withDone(["thr_parent"], ["thr_main", "thr_parent"]),
          {
            ...withDone([], ["thr_first"]),
            id: "bot_e",
            name: "Editor",
          },
        ],
      }),
      threads: changed("thr_first", { status: "error" }),
    });
    await screen.findByText("Editor");
    expect(threadIdsIn(botElement("bot_m"))).toEqual(["thr_main"]);
    expect(threadIdsIn(botElement("bot_e"))).toEqual(["thr_first"]);
    fireEvent.click(screen.getByText(strings.done(1)));
    expect(threadIdsIn(botElement("bot_m"))).toEqual([
      "thr_main",
      "thr_parent",
      "thr_spawned",
      "thr_second",
    ]);
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
      main: () => ({ threadId: "thr_main" }),
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
    await waitFor(() => expect(avatar.querySelector("[data-1ma-bot-main-status]")).not.toBeNull());
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
  // The call's connection drops before the server writes; the write lands
  // later, when finishLate() is called.
  loseThenSave?: number;
  // Another client assigns this conversation to the bot while the failing
  // call is in flight, before the bot is read again.
  othersAssign?: { threadId: string; place: "first" | "last" };
}) {
  const owned: string[] = [...(options.owned ?? [])];
  let call = 0;
  let late: (() => void) | null = null;
  const bind = (threadId: string, place: "first" | "last" | undefined) => {
    const at = owned.indexOf(threadId);
    if (at !== -1) owned.splice(at, 1);
    if (place === "first") owned.unshift(threadId);
    else owned.push(threadId);
  };
  const others = () => {
    if (options.othersAssign !== undefined) {
      bind(options.othersAssign.threadId, options.othersAssign.place);
    }
  };
  return {
    owned,
    finishLate: () => late?.(),
    bots: () => {
      if (options.listFails?.()) throw new Error("1ma-bots is restarting");
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
        others();
        // A refusal reaches the client with its code, as BotsError does.
        throw Object.assign(new Error("That conversation was archived"), { code: "invalid" });
      }
      if (call === options.loseThenSave) {
        late = () => bind(threadId, place);
        others();
        throw new Error("Failed to fetch");
      }
      bind(threadId, place);
      if (call === options.saveThenLose) {
        others();
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
    expect(toasts.error.mock.calls[0]![0]).toBe(strings.assignFailed("Marketer"));
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

  it("reports a refusal partway as a partial move", async () => {
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

describe("Codex review of afe5c1f: a refusal is an answer, a lost connection is not", () => {
  it("reports the refusal even when another client gave the bot that conversation meanwhile", async () => {
    toasts.error.mockClear();
    toasts.success.mockClear();
    const server = dropServer({
      refuse: 1,
      owned: ["keep"],
      othersAssign: { threadId: "thr_plain", place: "last" },
    });
    render({ bots: server.bots, assign: server.assign });
    await dropTwo(["thr_plain"], 10);
    await waitFor(() => expect(toasts.error).toHaveBeenCalled());
    const [title, options] = toasts.error.mock.calls[0]!;
    expect(title).toBe(strings.assignFailed("Marketer"));
    expect(options).toMatchObject({ description: expect.stringContaining("archived") });
    expect(toasts.success).not.toHaveBeenCalled();
    expect(server.owned).toEqual(["keep", "thr_plain"]);
  });

  it("does not say the rest stayed while the dropped call may still be saved", async () => {
    toasts.error.mockClear();
    toasts.success.mockClear();
    const server = dropServer({ loseThenSave: 2, owned: ["keep"] });
    render({ bots: server.bots, assign: server.assign });
    await dropTwo();
    await waitFor(() => expect(toasts.error).toHaveBeenCalled());
    expect(toasts.error.mock.calls[0]![0]).toBe(strings.unconfirmedAssigned("Marketer", 1, 2));
    expect(toasts.success).not.toHaveBeenCalled();
    expect(server.owned).toEqual(["keep", "thr_bot"]);
    server.finishLate();
    expect(server.owned).toEqual(["keep", "thr_bot", "thr_plain"]);
  });
});

describe("Codex review of 7c540b3: a partial refusal says what moved, not where the rest is", () => {
  it("makes no claim about a conversation another client gave the bot meanwhile", async () => {
    toasts.error.mockClear();
    toasts.success.mockClear();
    const server = dropServer({
      refuse: 2,
      owned: ["keep"],
      othersAssign: { threadId: "thr_plain", place: "last" },
    });
    render({ bots: server.bots, assign: server.assign });
    await dropTwo(["thr_plain", "thr_bot"], 10);
    await waitFor(() => expect(toasts.error).toHaveBeenCalled());
    const [title, options] = toasts.error.mock.calls[0]!;
    expect(title).toBe(strings.partlyAssigned("Marketer", 1, 2));
    expect(title).toContain("Moved 1 of 2");
    expect(title).not.toMatch(/stayed|where they were/);
    expect(options).toMatchObject({
      description: expect.stringContaining("archived"),
      action: { label: strings.open },
    });
    expect(toasts.success).not.toHaveBeenCalled();
    expect(server.owned).toEqual(["thr_bot", "keep", "thr_plain"]);
  });
});
