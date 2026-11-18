import { useSyncExternalStore } from "react";

// A thread dragged in the list can be dropped on a bot: on its face it
// becomes the bot's first conversation, on the rest of its row the last, as
// in Bots Sidebar. The list's own drag (dnd-kit in the copied thread list)
// reports the pointer here; the bots block marks its rows as targets and
// does the assignment.

export interface BotDropTarget {
  botId: string;
  place: "first" | "last";
}

type DropHandler = (threadIds: readonly string[], target: BotDropTarget) => void;

export const BOT_DROP_TARGET_ATTRIBUTE = "data-1ma-bot-drop";
export const BOT_DROP_FIRST_ATTRIBUTE = "data-1ma-bot-drop-first";

let dragged: readonly string[] = [];
let current: BotDropTarget | null = null;
let handler: DropHandler | null = null;
const listeners = new Set<() => void>();

function set(next: BotDropTarget | null) {
  if (next?.botId === current?.botId && next?.place === current?.place) return;
  current = next;
  for (const listener of listeners) listener();
}

function targetAt(point: { x: number; y: number }): BotDropTarget | null {
  for (const element of document.elementsFromPoint(point.x, point.y)) {
    const row = element.closest(`[${BOT_DROP_TARGET_ATTRIBUTE}]`);
    if (row === null) continue;
    const botId = row.getAttribute(BOT_DROP_TARGET_ATTRIBUTE);
    if (botId === null || botId === "") return null;
    const first = element.closest(`[${BOT_DROP_FIRST_ATTRIBUTE}]`) !== null;
    return { botId, place: first ? "first" : "last" };
  }
  return null;
}

export const botDrop = {
  // Called when a drag starts with the threads it carries; a drag that
  // carries no plain threads (an environment group) never targets a bot.
  start(threadIds: readonly string[]) {
    dragged = handler === null ? [] : threadIds;
    set(null);
  },
  // Called with every pointer move; true while the pointer is over a bot,
  // so the list shows none of its own drop places then.
  over(point: { x: number; y: number } | null): boolean {
    set(dragged.length === 0 || point === null ? null : targetAt(point));
    return current !== null;
  },
  end() {
    const target = current;
    const threadIds = dragged;
    dragged = [];
    set(null);
    if (target !== null && handler !== null && threadIds.length > 0) handler(threadIds, target);
  },
  cancel() {
    dragged = [];
    set(null);
  },
  register(next: DropHandler): () => void {
    handler = next;
    return () => {
      if (handler === next) handler = null;
    };
  },
};

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// The place a drag would land on this bot right now, or null.
export function useBotDropTarget(botId: string): BotDropTarget["place"] | null {
  return useSyncExternalStore(
    subscribe,
    () => (current?.botId === botId ? current.place : null),
    () => null,
  );
}
