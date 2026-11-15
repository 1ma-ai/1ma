// @vitest-environment jsdom
import { cleanup, fireEvent, screen } from "@testing-library/react";
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
        setPreference: (input: unknown) => input,
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

afterEach(() => {
  cleanup();
  resetPreferencesSyncForTest();
});

describe("the bots block", () => {
  it("shows a bot above the projects and its conversations only under it", async () => {
    render({ bots: () => ({ bots: [marketer()] }) });
    await screen.findByText("Marketer");
    await screen.findByText("Plain chat");
    expect(screen.queryByText("Creatives")).toBeNull();
    expect(screen.queryByText("Banner draft")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Marketer: 1 conversations" }));
    await screen.findByText("Creatives");
    expect(threadIdsInList().filter((id) => id === "thr_bot")).toHaveLength(1);
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
    expect(screen.queryByText("Creatives")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Marketer: 0 conversations" }));
    fireEvent.click(await screen.findByText(strings.done(1)));
    await screen.findByText("Creatives");
  });
});
