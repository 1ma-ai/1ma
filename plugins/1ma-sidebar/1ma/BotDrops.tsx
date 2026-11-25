import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefCallback,
} from "react";
import { useDndContext, useDroppable } from "@dnd-kit/core";
import { createBotDrop, getBotDropId, type BotDrop, type BotDropTarget } from "./thread-drop.js";

const BotDropContext = createContext<BotDrop>(createBotDrop());

export function BotDropProvider({ children }: { children: ReactNode }) {
  const [drop] = useState(createBotDrop);
  return <BotDropContext.Provider value={drop}>{children}</BotDropContext.Provider>;
}

export function useBotDrop(): BotDrop {
  return useContext(BotDropContext);
}

// Where a drag would land on this bot right now, or null.
export function useBotDropTarget(botId: string): BotDropTarget["place"] | null {
  const drop = useBotDrop();
  return useSyncExternalStore(drop.subscribe, () => {
    const target = drop.target();
    return target?.botId === botId ? target.place : null;
  });
}

// How many conversations the current drag would move to a bot.
export function useBotDropCount(): number {
  const drop = useBotDrop();
  return useSyncExternalStore(drop.subscribe, () => drop.dragged().length);
}

// The element that takes a drop in this place of the bot; a hidden bot takes none.
export function useBotDropPlace(
  bot: { id: string; hidden: boolean },
  place: BotDropTarget["place"],
): RefCallback<HTMLElement> {
  const drop = useBotDrop();
  const { id: botId, hidden } = bot;
  return useCallback(
    (element) => {
      if (!hidden) drop.setPlace({ botId, place }, element);
    },
    [botId, drop, hidden, place],
  );
}

// The bots are drawn outside the lists, each of which has its own drag: while
// one of them drags, the bots are its drop places.
export function BotDropTargets() {
  const drop = useBotDrop();
  const { active } = useDndContext();
  const count = useBotDropCount();
  if (active === null || count === 0) return null;
  return drop.places().map((place) => <BotDropPlace key={getBotDropId(place.target)} {...place} />);
}

function BotDropPlace({ target, element }: { target: BotDropTarget; element: HTMLElement }) {
  const { setNodeRef } = useDroppable({ id: getBotDropId(target) });
  useLayoutEffect(() => setNodeRef(element), [element, setNodeRef]);
  return null;
}
