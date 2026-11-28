import {
  getScrollableAncestors,
  pointerWithin,
  type Collision,
  type CollisionDetection,
  type DragOverEvent,
  type UniqueIdentifier,
} from "@dnd-kit/core";

// A thread dragged in the list can be dropped on a bot: on its face it
// becomes the bot's first conversation, on the rest of its row the last, as
// in Bots Sidebar. The bot's row and face are drop places of whichever list
// the drag started in (BotDropTargets), and the bots block does the assignment.

export interface BotDropTarget {
  botId: string;
  place: "first" | "last";
}

export interface BotDropHandler {
  // The conversations of a drag that a bot takes; the hint and the drop use
  // exactly these.
  accept(threadIds: readonly string[]): readonly string[];
  drop(threadIds: readonly string[], target: BotDropTarget): void;
}

const DROP_ID = /^1ma-bot-drop:(first|last):(.+)$/u;

export function getBotDropId({ botId, place }: BotDropTarget): string {
  return `1ma-bot-drop:${place}:${botId}`;
}

export function parseBotDropId(id: UniqueIdentifier | undefined): BotDropTarget | null {
  const match = DROP_ID.exec(String(id));
  return match ? { place: match[1] as BotDropTarget["place"], botId: match[2]! } : null;
}

type CollisionArgs = Parameters<CollisionDetection>[0];

// A row scrolled out of the list's view is no place to drop on.
function isInView(element: HTMLElement | null, point: { x: number; y: number }): boolean {
  return getScrollableAncestors(element).every((ancestor) => {
    const view = ancestor.getBoundingClientRect();
    return (
      point.x >= view.left && point.x <= view.right && point.y >= view.top && point.y <= view.bottom
    );
  });
}

// The bot under the pointer, its face before the row the face is on, and what
// is left for the list itself.
export function splitBotCollisions(args: CollisionArgs): {
  bot: Collision[];
  list: CollisionArgs;
} {
  const places: typeof args.droppableContainers = [];
  const others: typeof args.droppableContainers = [];
  for (const place of args.droppableContainers) {
    (parseBotDropId(place.id) === null ? others : places).push(place);
  }
  const point = args.pointerCoordinates;
  const hits =
    point === null
      ? []
      : pointerWithin({ ...args, droppableContainers: places }).filter(({ id }) =>
          isInView(places.find((place) => place.id === id)!.node.current, point),
        );
  const hit = hits.find(({ id }) => parseBotDropId(id)?.place === "first") ?? hits[0];
  return {
    bot: hit === undefined ? [] : [hit],
    list: { ...args, droppableContainers: others },
  };
}

// Over a bot the list shows none of its own drop places.
export function splitBotOver<Event extends Pick<DragOverEvent, "over" | "collisions">>(
  event: Event,
): { bot: BotDropTarget | null; list: Event } {
  const bot = parseBotDropId(event.over?.id);
  return { bot, list: bot === null ? event : { ...event, over: null, collisions: null } };
}

export function createBotDrop() {
  let dragged: readonly string[] = [];
  let current: BotDropTarget | null = null;
  let handler: BotDropHandler | null = null;
  const places = new Map<string, { target: BotDropTarget; element: HTMLElement }>();
  const listeners = new Set<() => void>();

  const set = (threadIds: readonly string[], target: BotDropTarget | null) => {
    dragged = threadIds;
    current = target;
    for (const listener of listeners) listener();
  };

  return {
    // Called when a drag starts with the threads it carries; a drag that
    // carries no plain threads (an environment group) never targets a bot.
    start(threadIds: readonly string[]) {
      set(handler === null ? [] : handler.accept(threadIds), null);
    },
    over(target: BotDropTarget | null) {
      if (target?.botId === current?.botId && target?.place === current?.place) return;
      set(dragged, target);
    },
    end() {
      const target = current;
      const threadIds = dragged;
      set([], null);
      if (target !== null && handler !== null && threadIds.length > 0)
        handler.drop(threadIds, target);
    },
    cancel() {
      set([], null);
    },
    register(next: BotDropHandler): () => void {
      handler = next;
      return () => {
        if (handler === next) handler = null;
      };
    },
    // Where a bot's row and face are drawn.
    setPlace(target: BotDropTarget, element: HTMLElement | null) {
      if (element === null) places.delete(getBotDropId(target));
      else places.set(getBotDropId(target), { target, element });
    },
    places: () => [...places.values()],
    target: () => current,
    dragged: () => dragged,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
export type BotDrop = ReturnType<typeof createBotDrop>;
