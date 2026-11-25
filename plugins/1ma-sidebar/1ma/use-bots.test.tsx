// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it } from "vitest";
import type {
  ExperimentalSidebarNavigationItem,
  PluginSidebarThreadsState,
} from "@get-bb/plugin-sdk/app";
import { installTestPluginRuntime, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { makeSidebarThread } from "../app/model/fixtures.js";

installTestPluginRuntime();
const { useWithoutBotThreads } = await import("./use-bots.js");

const PANEL = {
  id: "plugin:1ma-bots:bots",
  action: { kind: "open-plugin-panel", pluginId: "1ma-bots", panelId: "bots" },
} as unknown as ExperimentalSidebarNavigationItem;
const OLD = [makeSidebarThread({ id: "plain" }), makeSidebarThread({ id: "bots" })];
// A new conversation, and one that moves under a bot's conversation that is not in the list.
const NEW = [
  makeSidebarThread({ id: "plain", parentThreadId: "elsewhere" }),
  OLD[1]!,
  makeSidebarThread({ id: "new" }),
];

afterEach(cleanup);

it("a new conversation shows in its project only once it is known to be no bot's", async () => {
  const bots = new Set(["bots", "elsewhere"]);
  const asked: string[][] = [];
  let answer = () => {};
  function Probe() {
    const [threads, setThreads] = useState(OLD);
    const state = useWithoutBotThreads({ threads } as never as PluginSidebarThreadsState);
    return (
      <button onClick={() => setThreads(NEW)}>{state.threads.map(({ id }) => id).join()}</button>
    );
  }
  renderSlot({ component: Probe as never }, {} as never, {
    sidebarNavigation: { items: [PANEL] },
    rpc: {
      "bots.v1.list": () => ({
        bots: [
          {
            id: "bot_m",
            name: "Marketer",
            role: "",
            appearance: { shape: "circle", face: "calm", color: "#7c6cf0" },
            capabilities: [],
            hidden: false,
          },
        ],
      }),
      "bots.v1.forThreads": async (input: unknown) => {
        const { keys } = input as { keys: string[] };
        asked.push(keys);
        if (asked.length > 1) await new Promise<void>((resolve) => (answer = resolve));
        return Object.fromEntries(
          keys.map((id) => [
            id,
            bots.has(id)
              ? { botId: "bot_m", startedFromBot: true, completed: false, position: 0 }
              : null,
          ]),
        );
      },
    },
  });
  const button = screen.getByRole("button");
  expect(button.textContent).toBe("plain,bots");
  await waitFor(() => expect(button.textContent).toBe("plain"));
  fireEvent.click(button);
  await waitFor(() => expect(asked).toHaveLength(2));
  expect(asked[1]!.sort()).toEqual(["elsewhere", "new"]);
  expect(button.textContent).toBe("");
  answer();
  await waitFor(() => expect(button.textContent).toBe("new"));
});
