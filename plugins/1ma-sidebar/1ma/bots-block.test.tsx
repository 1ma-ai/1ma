// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExperimentalSidebarNavigationItem } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { makePluginProject, makeSidebarThread } from "../app/model/fixtures.js";
import { resetPreferencesSyncForTest } from "../app/preferences/preferences-sync.js";
import { defaultPreferences } from "../shared/preferences.js";
import type { SidebarBot } from "./bots-rpc.js";
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
      sidebarThreads: { projects: PROJECTS, sections: [], threads: THREADS },
      sidebarNavigation: { items: options.botsInstalled === false ? [] : [BOTS_PANEL] },
      settings: options.settings,
      rpc: {
        listPreferences: () => ({ preferences: defaultPreferences() }),
        setPreference: options.setPreference ?? ((input: unknown) => input),
        "bots.v1.list": options.bots ?? (() => ({ bots: [] })),
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

  it("under the name it shows the main conversation, and the role only as the name's tooltip", async () => {
    render({ bots: () => ({ bots: [marketer()] }) });
    const name = await screen.findByText("Marketer");
    const main = botElement("bot_m").querySelector("[data-1ma-bot-main-conversation]");
    expect(main?.textContent).toBe("Creatives");
    expect(name.getAttribute("title")).toBe("Marketer — Landing pages");
    expect(screen.queryByText("Landing pages")).toBeNull();
  });

  it("offers a new conversation with the stock new-thread button on the bot's row", async () => {
    render({ bots: () => ({ bots: [marketer()] }) });
    await screen.findByText("Marketer");
    fireEvent.click(screen.getByRole("button", { name: strings.newConversation("Marketer") }));
    await screen.findByRole("dialog");
  });
});
