// @vitest-environment jsdom
import type { CollisionDetection, DragOverEvent } from "@dnd-kit/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createBotDrop,
  getBotDropId,
  parseBotDropId,
  splitBotCollisions,
  splitBotOver,
  type BotDropTarget,
} from "./thread-drop.js";

type CollisionArgs = Parameters<CollisionDetection>[0];

const FIRST: BotDropTarget = { botId: "bot_a", place: "first" };
const LAST: BotDropTarget = { botId: "bot_a", place: "last" };

// A list row above a bot's row; the bot's face is drawn at x 0-32.
function collisionsAt(pointerCoordinates: CollisionArgs["pointerCoordinates"], parent?: Element) {
  const rects = new Map<string, DOMRect>([
    ["thr_row", new DOMRect(0, 0, 200, 60)],
    [getBotDropId(LAST), new DOMRect(0, 60, 200, 40)],
    [getBotDropId(FIRST), new DOMRect(0, 60, 32, 40)],
  ]);
  const droppableContainers = [...rects.keys()].map((id) => {
    const element = document.createElement("div");
    (parent ?? document.body).append(element);
    return { id, node: { current: element } };
  });
  const { bot, list } = splitBotCollisions({
    pointerCoordinates,
    droppableRects: rects,
    droppableContainers,
  } as unknown as CollisionArgs);
  return { bot: bot.map(({ id }) => parseBotDropId(id)), list: list.droppableContainers };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("what the pointer is over in a drag", () => {
  it("is the bot's face before its row, and nothing off the bot", () => {
    expect(collisionsAt({ x: 10, y: 80 }).bot).toEqual([FIRST]);
    expect(collisionsAt({ x: 100, y: 80 }).bot).toEqual([LAST]);
    expect(collisionsAt({ x: 100, y: 30 }).bot).toEqual([]);
    expect(collisionsAt(null).bot).toEqual([]);
  });

  it("is not a bot scrolled out of the list's view", () => {
    const view = document.createElement("div");
    view.style.overflow = "auto";
    document.body.append(view);
    view.getBoundingClientRect = () => new DOMRect(0, 0, 200, 70);
    expect(collisionsAt({ x: 100, y: 65 }, view).bot).toEqual([LAST]);
    expect(collisionsAt({ x: 100, y: 80 }, view).bot).toEqual([]);
  });

  it("leaves the list its own drop places only", () => {
    expect(collisionsAt({ x: 100, y: 30 }).list.map(({ id }) => id)).toEqual(["thr_row"]);
    const overBot = {
      over: { id: getBotDropId(LAST) },
      collisions: [{ id: getBotDropId(LAST) }],
    } as DragOverEvent;
    expect(splitBotOver(overBot)).toEqual({ bot: LAST, list: { over: null, collisions: null } });
    const overRow = { over: { id: "thr_row" }, collisions: [{ id: "thr_row" }] } as DragOverEvent;
    expect(splitBotOver(overRow)).toEqual({ bot: null, list: overRow });
  });
});

describe("dropping a dragged thread on a bot", () => {
  it("gives the bot what was dragged to the place it was dropped in", () => {
    const drops: unknown[] = [];
    const drop = createBotDrop();
    drop.register({
      accept: (threadIds) => threadIds,
      drop: (threadIds, target) => drops.push({ threadIds, target }),
    });
    drop.start(["thr_1"]);
    drop.over(LAST);
    drop.over(FIRST);
    drop.end();
    drop.start(["thr_2", "thr_3"]);
    drop.over(LAST);
    drop.end();
    drop.start(["thr_4"]);
    drop.over(LAST);
    drop.over(null);
    drop.end();
    expect(drops).toEqual([
      { threadIds: ["thr_1"], target: FIRST },
      { threadIds: ["thr_2", "thr_3"], target: LAST },
    ]);
  });

  it("a drag that carries no plain thread and a cancelled drag drop nothing", () => {
    const handler = vi.fn();
    const drop = createBotDrop();
    drop.register({ accept: (threadIds) => threadIds, drop: handler });
    drop.start([]);
    drop.over(LAST);
    drop.end();
    drop.start(["thr_1"]);
    drop.over(LAST);
    drop.cancel();
    drop.end();
    expect(handler).not.toHaveBeenCalled();
  });

  it("carries what the bots block accepts", () => {
    const drops: unknown[] = [];
    const drop = createBotDrop();
    drop.register({
      accept: (threadIds) => threadIds.filter((id) => id !== "thr_child"),
      drop: (threadIds) => drops.push(threadIds),
    });
    drop.start(["thr_child"]);
    expect(drop.dragged()).toEqual([]);
    drop.start(["thr_root", "thr_child"]);
    drop.over(LAST);
    drop.end();
    expect(drops).toEqual([["thr_root"]]);
  });
});
