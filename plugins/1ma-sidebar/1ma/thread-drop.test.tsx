// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { botDrop } from "./thread-drop.js";

// The face is drawn at x 0-32; the row's click target covers the whole row,
// and hit testing finds only that target, as in the browser.
function botRow(botId: string) {
  const row = document.createElement("div");
  row.setAttribute("data-1ma-bot-drop", botId);
  const face = document.createElement("span");
  face.setAttribute("data-1ma-bot-drop-first", "");
  face.getBoundingClientRect = () => new DOMRect(0, 0, 32, 32);
  const target = document.createElement("button");
  row.append(face, target);
  document.body.append(row);
  return { face: target, name: target };
}

function pointAt(element: Element | null, x = 1) {
  document.elementsFromPoint = () => (element === null ? [] : [element]);
  return { x, y: 1 };
}

afterEach(() => {
  document.body.innerHTML = "";
  botDrop.cancel();
});

describe("dropping a dragged thread on a bot", () => {
  it("on the face makes it first, on the rest of the row last, elsewhere nothing", () => {
    const drops: unknown[] = [];
    const unregister = botDrop.register({
      accept: (threadIds) => threadIds,
      drop: (threadIds, target) => drops.push({ threadIds, target }),
    });
    const { face, name } = botRow("bot_a");

    botDrop.start(["thr_1"]);
    expect(botDrop.over(pointAt(face))).toBe(true);
    botDrop.end();
    botDrop.start(["thr_2", "thr_3"]);
    expect(botDrop.over(pointAt(name, 100))).toBe(true);
    botDrop.end();
    botDrop.start(["thr_4"]);
    expect(botDrop.over(pointAt(document.body))).toBe(false);
    botDrop.end();
    unregister();

    expect(drops).toEqual([
      { threadIds: ["thr_1"], target: { botId: "bot_a", place: "first" } },
      { threadIds: ["thr_2", "thr_3"], target: { botId: "bot_a", place: "last" } },
    ]);
  });

  it("a drag that carries no plain thread, a cancelled drag and a hidden bot drop nothing", () => {
    const handler = vi.fn();
    const unregister = botDrop.register({ accept: (threadIds) => threadIds, drop: handler });
    const { name } = botRow("bot_a");
    botDrop.start([]);
    expect(botDrop.over(pointAt(name))).toBe(false);
    botDrop.end();
    botDrop.start(["thr_1"]);
    botDrop.over(pointAt(name));
    botDrop.cancel();
    botDrop.end();
    const hidden = document.createElement("div");
    hidden.setAttribute("data-1ma-bot-drop", "");
    document.body.append(hidden);
    botDrop.start(["thr_1"]);
    expect(botDrop.over(pointAt(hidden))).toBe(false);
    botDrop.end();
    unregister();
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("what a drop on a bot moves", () => {
  it("is what the bots block accepts, and a drag it accepts nothing of targets no bot", () => {
    const drops: unknown[] = [];
    const unregister = botDrop.register({
      accept: (threadIds) => threadIds.filter((id) => id !== "thr_child"),
      drop: (threadIds) => drops.push(threadIds),
    });
    const { name } = botRow("bot_a");
    botDrop.start(["thr_child"]);
    expect(botDrop.over(pointAt(name, 100))).toBe(false);
    botDrop.end();
    botDrop.start(["thr_root", "thr_child"]);
    expect(botDrop.over(pointAt(name, 100))).toBe(true);
    botDrop.end();
    unregister();
    expect(drops).toEqual([["thr_root"]]);
  });
});
