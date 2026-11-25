import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useAtom, useAtomValue } from "jotai";
import {
  experimental_NewThreadComposer as NewThreadComposer,
  experimental_PluginRpcCallError as PluginRpcCallError,
  experimental_resolveThreadStatus as resolveThreadStatus,
  experimental_ThreadStatusGlyph as ThreadStatusGlyph,
  experimental_useRpcKeyedQuery as useRpcKeyedQuery,
  experimental_useRpcMutation as useRpcMutation,
  experimental_useRpcQuery as useRpcQuery,
  experimental_useSidebarNavigation as useSidebarNavigation,
  experimental_useSidebarThreads as useSidebarThreads,
  useBbNavigate,
  type PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import {
  COARSE_POINTER_ICON_SIZE_CLASS,
  COARSE_POINTER_ROW_HEIGHT_CLASS,
} from "@/components/ui/coarse-pointer-sizing";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { LIST_HOVER_TRANSITION } from "@/components/ui/motion";
import {
  SIDEBAR_HOVER_ACTIONS_CLASS,
  SIDEBAR_HOVER_ACTIONS_INSET_CLASS,
  SIDEBAR_HOVER_ACTIONS_MOBILE_ALWAYS_VALUE,
  SIDEBAR_HOVER_ACTIONS_ROW_CLASS,
} from "@/components/ui/sidebar-hover-actions";
import {
  SIDEBAR_CONTROL_BUTTON_CLASS,
  SIDEBAR_GROUP_TEXT_CLASS,
  SIDEBAR_ROW_ACCENT_STATE_CLASS,
  SIDEBAR_ROW_BASE_CLASS,
  SIDEBAR_ROW_INTERACTIVE_STATE_CLASS,
  getSidebarThreadRowPaddingLeft,
} from "@/components/ui/sidebar-row-classes";
import { cn } from "@/lib/utils";
import { usePluginThreadRowStatusForThreads } from "../app/list/groupRollups.js";
import { useThreadsHaveDraft } from "../app/list/sidebarDraftPresence.js";
import { BotThreadTree } from "./BotThreadTree.js";
import { ThreadTreeGroupLine } from "../app/list/ProjectRow.js";
import { TopLevelSidebarSection } from "../app/list/TopLevelSidebarSection.js";
import type { ThreadComparator } from "../app/model/project-thread-groups.js";
import { sidebarThreadLifecyclesAtom } from "../app/preferences/atoms.js";
import { createSyncedPreferenceAtom } from "../app/preferences/synced-preference-atom.js";
import { SidebarChildToggleChevron } from "../app/rows/SidebarChildToggleChevron.js";
import { SidebarControlButton, SidebarRowControls } from "../app/rows/SidebarRowControls.js";
import { useBotDrop, useBotDropCount, useBotDropPlace, useBotDropTarget } from "./BotDrops.js";
import { avatarDataUrl } from "./bots/avatar.js";
import { keepsOpen } from "./bots/branch.js";
import { botsRpc, type BotSummary } from "./bots/contract.js";
import { botBranches, type Members } from "./bot-threads.js";
import { strings } from "./strings.js";
import type { BotDropHandler } from "./thread-drop.js";
import { BOTS_PLUGIN_ID, useSidebarBots } from "./use-bots.js";
import { toast } from "sonner";
import { getMutationErrorMessage } from "../app/ui/mutation-errors.js";

// Collapsed bots are kept like bb's collapsed threads: a synced preference.
const collapsedBotsAtom = createSyncedPreferenceAtom("collapsedBots");
const BLOCK_KEY = "bots";
// The stock row's new-thread icon, the one project headers use.
const NEW_ICON = "MessageSquarePlus";

interface TreeState {
  collapsedThreadIds: Set<string>;
  collapsedEnvironmentIds: Set<string>;
  onToggleThreadCollapsed: (threadId: string) => void;
  onToggleEnvironmentCollapsed: (environmentId: string) => void;
}

interface BotsBlockProps extends TreeState {
  selectedThreadId?: string;
  onProjectSelect?: () => void;
}

// bots.v1.assign gives these answers before it writes anything: the host's
// own checks of the call and the plugin's refusals (BotsError).
const REFUSALS: ReadonlySet<PluginRpcCallError["code"]> = new Set([
  "forbidden",
  "not_found",
  "conflict",
  "invalid",
  "invalid_json",
  "invalid_input",
  "unknown_method",
]);

function isRefusal(error: unknown): boolean {
  return error instanceof PluginRpcCallError && REFUSALS.has(error.code);
}

export function BotsBlock({ selectedThreadId, onProjectSelect, ...tree }: BotsBlockProps) {
  const lifecycles = useAtomValue(sidebarThreadLifecyclesAtom);
  const { threads } = useSidebarThreads({ experimental_lifecycles: lifecycles });
  const state = useSidebarBots(threads);
  const botDrop = useBotDrop();
  const navigation = useSidebarNavigation();
  const [collapsed, setCollapsed] = useAtom(collapsedBotsAtom);
  const toggle = (key: string) =>
    setCollapsed((current) =>
      current.includes(key) ? current.filter((item) => item !== key) : [...current, key],
    );
  const [showHidden, setShowHidden] = useState(false);
  const visible = useMemo(() => state.bots.filter((bot) => !bot.hidden), [state.bots]);
  const hidden = useMemo(() => state.bots.filter((bot) => bot.hidden), [state.bots]);
  const conversations = useBotConversations(state.members, threads);
  const setHidden = useRpcMutation({
    contract: botsRpc,
    pluginId: BOTS_PLUGIN_ID,
    method: "bots.v1.setHidden",
  });
  const assign = useRpcMutation({
    contract: botsRpc,
    pluginId: BOTS_PLUGIN_ID,
    method: "bots.v1.assign",
  });
  // Fresh reads, to learn where a conversation ended up when an assignment's
  // answer was lost.
  const readMembers = useRpcMutation({
    contract: botsRpc,
    pluginId: BOTS_PLUGIN_ID,
    method: "bots.v1.forThreads",
  });
  const readThreads = useRpcMutation({
    contract: botsRpc,
    pluginId: BOTS_PLUGIN_ID,
    method: "bots.v1.threads",
  });
  const navigate = useBbNavigate();
  // A dropped conversation is scrolled into view once the bot shows it.
  const reveal = useRef<{ botId: string; threadId: string } | null>(null);
  const onDrop = useRef<BotDropHandler>({ accept: () => [], drop: () => undefined });
  useEffect(() => {
    onDrop.current = {
      // Only top-level conversations belong to a bot; a dragged sub-thread
      // follows its parent, so it is not part of what a drop moves.
      accept: (threadIds) =>
        threadIds.filter((threadId) => conversations.parentOf(threadId) === null),
      drop: (threadIds, target) => {
        const bot = state.bots.find((item) => item.id === target.botId);
        if (bot === undefined) return;
        // Assigning in reverse keeps a dragged selection in its order at the top.
        const ordered = target.place === "first" ? [...threadIds].reverse() : threadIds;
        const { members } = state;
        void (async () => {
          const confirmed: string[] = [];
          let failure: unknown = null;
          for (const threadId of ordered) {
            try {
              await assign.mutate({ threadId, botId: bot.id, place: target.place });
              confirmed.push(threadId);
            } catch (error) {
              failure = error;
              break;
            }
          }
          // The call that failed is the only one in doubt: the ones before it
          // were confirmed and the ones after it were never sent. A refusal
          // is a definite answer, since bots.v1.assign refuses only before it
          // writes. Any other failure may have been saved or may still be
          // saved, so its place is read again and only what the read shows is
          // counted: a conversation from elsewhere that the bot now has, or
          // one it already had that stands where it was put. Anything else
          // stays unknown rather than reported as left in place.
          let moved: readonly string[] = confirmed;
          let known = true;
          const doubtful =
            failure === null || isRefusal(failure) ? undefined : ordered[confirmed.length];
          if (doubtful !== undefined) {
            known = false;
            try {
              const there =
                members[doubtful]?.botId === bot.id
                  ? (await readThreads.mutate({ botId: bot.id, from: target.place, limit: 1 }))
                      .threads[0]?.threadId === doubtful
                  : (await readMembers.mutate({ keys: [doubtful] }))[doubtful]?.botId === bot.id;
              if (there) {
                moved = [...confirmed, doubtful];
                known = true;
              }
            } catch {
              // Still unknown.
            }
          }
          const shown = threadIds.find((threadId) => moved.includes(threadId));
          if (shown !== undefined) {
            if (collapsed.includes(bot.id)) {
              setCollapsed((current) => current.filter((item) => item !== bot.id));
            }
            reveal.current = { botId: bot.id, threadId: shown };
          }
          const open =
            shown === undefined
              ? undefined
              : { label: strings.open, onClick: () => navigate.toThread(shown) };
          if (failure === null || (known && moved.length === threadIds.length)) {
            toast.success(strings.assigned(bot.name, moved.length), { action: open });
            return;
          }
          const reason = getMutationErrorMessage({
            error: failure,
            fallbackMessage: strings.assignFailed(bot.name),
          });
          if (!known) {
            toast.error(strings.unconfirmedAssigned(bot.name, moved.length, threadIds.length), {
              description: reason,
              action: open,
            });
            return;
          }
          if (moved.length === 0) {
            toast.error(strings.assignFailed(bot.name), { description: reason });
            return;
          }
          toast.error(strings.partlyAssigned(bot.name, moved.length, threadIds.length), {
            description: reason,
            action: open,
          });
        })();
      },
    };
  });
  useEffect(
    () =>
      botDrop.register({
        accept: (threadIds) => onDrop.current.accept(threadIds),
        drop: (threadIds, target) => onDrop.current.drop(threadIds, target),
      }),
    [botDrop],
  );
  useEffect(() => {
    const pending = reveal.current;
    if (pending === null) return;
    const bot = [...document.querySelectorAll("[data-bot-id]")].find(
      (element) => element.getAttribute("data-bot-id") === pending.botId,
    );
    const row = [...(bot?.querySelectorAll("a[data-sidebar-thread-id]") ?? [])].find(
      (element) => element.getAttribute("data-sidebar-thread-id") === pending.threadId,
    );
    if (row === undefined) return;
    row.scrollIntoView({ block: "nearest" });
    reveal.current = null;
  });
  const { panelId } = state;
  if (state.status === "off" || panelId === null) return null;
  // The block appears with the first bot, which is made on the Bots page
  // (owner's decision of 18.11.2026); while the list loads it is not known
  // yet whether there is one. When bots cannot be read it shows, to say so.
  if (state.status === "loading" || (state.status === "ready" && state.bots.length === 0)) {
    return null;
  }
  const openBotsPage = () => navigation.actions.activate(panelId, { target: "current" });
  return (
    <div className="pb-4" data-1ma-bots-block="">
      <TopLevelSidebarSection
        label={strings.title}
        sectionId="1ma-bots"
        // A collapsed section hides its body, and the failure notice is
        // the only thing this block has to say then; the saved choice
        // applies again once the bots are read.
        collapseControl={
          state.status === "unavailable"
            ? undefined
            : {
                isCollapsed: collapsed.includes(BLOCK_KEY),
                onToggleCollapsed: () => toggle(BLOCK_KEY),
              }
        }
        collapsedThreads={visible.flatMap((bot) => conversations.of(bot).open)}
        actionsMobileAlways
        actions={
          <SidebarRowControls
            primaryAction={
              <SidebarControlButton label={strings.newBot} icon={NEW_ICON} onClick={openBotsPage} />
            }
          >
            {null}
          </SidebarRowControls>
        }
      >
        {state.status === "unavailable" ? (
          <p className={`px-2 py-1 text-xs ${SIDEBAR_GROUP_TEXT_CLASS}`}>{strings.unavailable}</p>
        ) : (
          <>
            {[...visible, ...(showHidden ? hidden : [])].map((bot) => (
              <BotRow
                key={bot.id}
                bot={bot}
                members={state.members}
                conversations={conversations.of(bot)}
                collapsed={collapsed.includes(bot.id)}
                onToggle={() => toggle(bot.id)}
                onOpenBotsPage={openBotsPage}
                onSetHidden={(next) => void setHidden.mutate({ botId: bot.id, hidden: next })}
                selectedThreadId={selectedThreadId}
                onProjectSelect={onProjectSelect}
                tree={tree}
              />
            ))}
            {hidden.length > 0 ? (
              <button
                type="button"
                data-1ma-hidden-bots=""
                className={cn(
                  SIDEBAR_ROW_BASE_CLASS,
                  COARSE_POINTER_ROW_HEIGHT_CLASS,
                  SIDEBAR_ROW_INTERACTIVE_STATE_CLASS,
                  "w-full gap-1 text-xs",
                  SIDEBAR_GROUP_TEXT_CLASS,
                )}
                style={{ paddingLeft: getSidebarThreadRowPaddingLeft(0) }}
                aria-expanded={showHidden}
                onClick={() => setShowHidden(!showHidden)}
              >
                {strings.hiddenBots(hidden.length)}
                <Icon
                  name="ChevronRight"
                  className={cn(
                    "size-3 transition-transform duration-150",
                    showHidden && "rotate-90",
                  )}
                />
              </button>
            ) : null}
          </>
        )}
      </TopLevelSidebarSection>
    </div>
  );
}

interface BotConversations {
  // Every conversation with its sub-threads. Done covers the whole branch,
  // unless something in the branch keeps it open.
  open: PluginSidebarThread[];
  done: PluginSidebarThread[];
  doneCount: number;
  compare: ThreadComparator;
  // The conversation above this one in its bot's tree.
  parentOf: (threadId: string) => string | null;
}

function useBotConversations(members: Members, threads: readonly PluginSidebarThread[]) {
  return useMemo(() => {
    const byId = new Map(threads.map((thread) => [thread.id, thread]));
    const branches = botBranches(members, threads);
    const branchOf = (threadId: string) => branches.get(threadId)?.threadIds ?? [];
    const parentOf = (threadId: string) => branchOf(threadId)[1] ?? null;
    const positionOf = (threadId: string) =>
      members[threadId]?.position ?? Number.POSITIVE_INFINITY;
    const compare: ThreadComparator = (left, right) => {
      const [first, second] = [positionOf(left.id), positionOf(right.id)];
      return first === second ? right.createdAt - left.createdAt : first - second;
    };
    const shownBy = new Map<string, PluginSidebarThread[]>();
    for (const thread of threads) {
      const botId = branches.get(thread.id)?.botId;
      if (botId === undefined || thread.isHidden) continue;
      const shown = shownBy.get(botId) ?? [];
      shownBy.set(botId, shown);
      shown.push(thread);
    }
    const byBot = new Map<string, BotConversations>();
    for (const [botId, shown] of shownBy) {
      const kept = new Set(shown.filter(keepsOpen).flatMap((thread) => branchOf(thread.id)));
      const marked = new Set(
        shown.map(({ id }) => id).filter((id) => members[id]?.completed && !kept.has(id)),
      );
      const done = shown.filter((thread) =>
        branchOf(thread.id).some((threadId) => marked.has(threadId)),
      );
      const doneIds = new Set(done.map((thread) => thread.id));
      const open = shown.filter((thread) => !doneIds.has(thread.id));
      byBot.set(botId, {
        open,
        done,
        doneCount: done.filter(({ id }) => !doneIds.has(parentOf(id) ?? "")).length,
        compare,
        parentOf,
      });
    }
    const empty: BotConversations = {
      open: [],
      done: [],
      doneCount: 0,
      compare: () => 0,
      parentOf,
    };
    return {
      of: (bot: BotSummary) => byBot.get(bot.id) ?? empty,
      parentOf: (threadId: string) => byId.get(threadId)?.parentThreadId ?? null,
    };
  }, [members, threads]);
}

// 1ma-bots alone knows which conversation is main. A status in the tree can
// change it, so it is read again when the bot's rows do.
export function useMainThread(
  bot: BotSummary,
  { open, done }: Pick<BotConversations, "open" | "done">,
): PluginSidebarThread | null {
  const { data, isFetching, refetch } = useRpcKeyedQuery({
    contract: botsRpc,
    pluginId: BOTS_PLUGIN_ID,
    method: "bots.v1.mains",
    keys: [bot.id],
  });
  const rows = [...open, ...done];
  const state = rows.map((thread) =>
    [thread.id, thread.parentThreadId, thread.isArchived, keepsOpen(thread)].join(":"),
  );
  const seen = state.sort().join();
  // Asking again during a reading would only join it.
  const asked = useRef(seen);
  useEffect(() => {
    if (isFetching || asked.current === seen) return;
    asked.current = seen;
    void refetch();
  }, [isFetching, refetch, seen]);
  return rows.find((thread) => thread.id === data?.[bot.id]) ?? null;
}

// The bot's state at a glance, drawn on its image: the glyph bb draws for its
// main conversation (the one a click opens) on the corner, a dot for each
// other conversation that is working (two and a plus past three, the count in
// the tooltip), and a red mark for an unread error elsewhere.
function BotAvatar({ bot, conversations }: { bot: BotSummary; conversations: BotConversations }) {
  const { open } = conversations;
  const face = useBotDropPlace(bot, "first");
  const main = useMainThread(bot, conversations);
  const mainThreads = useMemo(() => (main === null ? NO_THREADS : [main]), [main]);
  const hasDraft = useThreadsHaveDraft(mainThreads);
  const rowStatus = usePluginThreadRowStatusForThreads(mainThreads);
  const status = resolveThreadStatus({
    thread: main,
    hiddenThreads: NO_THREADS,
    hasUnsubmittedDraft: hasDraft,
    rowStatus,
  });
  // A hidden bot's conversations show in their projects, so its row stays quiet.
  const quiet = bot.hidden;
  // Each conversation's own state, worked out the way bb's rows do.
  const own = (thread: PluginSidebarThread) =>
    resolveThreadStatus({
      thread,
      hiddenThreads: NO_THREADS,
      hasUnsubmittedDraft: false,
      rowStatus: null,
    });
  const others = quiet
    ? 0
    : open.filter((thread) => thread.id !== main?.id && own(thread).isWorking).length;
  const unreadError =
    !quiet &&
    status.indicator !== "unread-error" &&
    open.some((thread) => own(thread).indicator === "unread-error");
  const label = [
    main === null ? null : strings.mainConversationStatus(status.label),
    others > 0 ? strings.othersWorking(others) : null,
    unreadError ? strings.unreadError : null,
  ]
    .filter((part) => part !== null)
    .join("; ");
  const dots = others > 3 ? 2 : others;
  const showMain = !quiet && (status.indicator !== "none" || status.rowStatus !== null);
  return (
    <span
      ref={face}
      className="relative shrink-0"
      data-1ma-bot-avatar=""
      role="img"
      aria-label={label === "" ? bot.name : `${bot.name}: ${label}`}
      title={label === "" ? undefined : label}
    >
      <img src={avatarDataUrl(bot.appearance)} alt="" className="size-8 rounded-full" />
      {unreadError ? (
        <span
          data-1ma-bot-unread-error=""
          className="absolute -top-1 -right-1 flex size-3.5 items-center justify-center rounded-full bg-destructive text-[9px] leading-none font-bold text-destructive-foreground"
        >
          !
        </span>
      ) : null}
      {showMain || dots > 0 ? (
        <span className="absolute -right-1.5 -bottom-1 flex items-center gap-px rounded-full bg-sidebar pl-0.5">
          {Array.from({ length: dots }, (_, index) => (
            <span
              key={index}
              data-1ma-bot-other-working=""
              className="size-1 rounded-full bg-sidebar-foreground/70 motion-safe:animate-pulse"
            />
          ))}
          {others > 3 ? (
            <span data-1ma-bot-other-working-more="" className="text-[9px] leading-none">
              +
            </span>
          ) : null}
          {showMain ? (
            <span data-1ma-bot-main-status={status.indicator}>
              <ThreadStatusGlyph indicator={status.indicator} rowStatus={status.rowStatus} />
            </span>
          ) : null}
        </span>
      ) : null}
    </span>
  );
}

const NO_THREADS: readonly PluginSidebarThread[] = [];

// The stock thread row's room for one quick action before its menu.
const ONE_ACTION_INSET = {
  "--bb-sidebar-hover-actions-inset": "calc(var(--spacing) * 7.5)",
} as CSSProperties;

// A bot is drawn as bb's parent thread row with its metadata line: the bot's
// image where the thread's icon goes, the name with the chevron right after
// it, the title of its main conversation under the name, and on hover the
// stock new-thread icon and menu. Its conversations sit under the guide line.
function BotRow({
  bot,
  members,
  conversations,
  collapsed,
  onToggle,
  onOpenBotsPage,
  onSetHidden,
  selectedThreadId,
  onProjectSelect,
  tree,
}: {
  bot: BotSummary;
  members: Members;
  conversations: BotConversations;
  collapsed: boolean;
  onToggle: () => void;
  onOpenBotsPage: () => void;
  onSetHidden: (hidden: boolean) => void;
  selectedThreadId?: string;
  onProjectSelect?: () => void;
  tree: TreeState;
}) {
  const navigate = useBbNavigate();
  const [showDone, setShowDone] = useState(false);
  const [composing, setComposing] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const { open, done, doneCount, compare, parentOf } = conversations;
  const main = useRpcMutation({
    contract: botsRpc,
    pluginId: BOTS_PLUGIN_ID,
    method: "bots.v1.main",
  });
  // A hidden bot's conversations stay in their projects; shown here, it is
  // only a row to bring it back.
  const hasChildren = !bot.hidden && (open.length > 0 || doneCount > 0);
  const isCollapsed = collapsed && hasChildren;
  const row = useBotDropPlace(bot, "last");
  const dropPlace = useBotDropTarget(bot.id);
  const dropCount = useBotDropCount();

  // Like bb's thread reveal: opening a conversation of a collapsed bot shows it.
  const lastSelected = useRef(selectedThreadId);
  useEffect(() => {
    if (lastSelected.current === selectedThreadId) return;
    lastSelected.current = selectedThreadId;
    const inside = [...open, ...(showDone ? done : [])];
    if (collapsed && inside.some((thread) => thread.id === selectedThreadId)) onToggle();
  }, [collapsed, done, onToggle, open, selectedThreadId, showDone]);

  // Asked at the click, so it opens what a letter sent now would reach.
  const openBot = async () => {
    try {
      const { threadId } = await main.mutate({ botId: bot.id });
      if (threadId === null) {
        setComposing(true);
        return;
      }
      navigate.toThread(threadId);
      onProjectSelect?.();
    } catch (error) {
      toast.error(
        getMutationErrorMessage({ error, fallbackMessage: strings.openFailed(bot.name) }),
      );
    }
  };
  const treeProps = {
    members,
    compareThreads: compare,
    parentOf,
    selectedThreadId,
    onProjectSelect,
    depthOffset: 1,
    ...tree,
  };
  return (
    <div className="relative space-y-0.5" data-bot-id={bot.id}>
      <div
        ref={row}
        data-sidebar-rename-row=""
        data-1ma-bot-row=""
        data-1ma-bot-hidden={bot.hidden ? "" : undefined}
        data-1ma-drop-place={dropPlace ?? undefined}
        className={cn(
          SIDEBAR_HOVER_ACTIONS_ROW_CLASS,
          "group/thread-row relative cursor-pointer",
          bot.hidden && "opacity-55",
          SIDEBAR_ROW_BASE_CLASS,
          LIST_HOVER_TRANSITION,
          COARSE_POINTER_ROW_HEIGHT_CLASS,
          "h-auto min-h-[var(--bb-sidebar-row-height)] max-md:pointer-coarse:h-auto max-md:pointer-coarse:min-h-[var(--bb-sidebar-row-height-coarse)]",
          SIDEBAR_ROW_INTERACTIVE_STATE_CLASS,
          SIDEBAR_ROW_ACCENT_STATE_CLASS,
          (menuOpen || dropPlace !== null) && "bg-sidebar-accent",
        )}
        style={{ paddingLeft: getSidebarThreadRowPaddingLeft(0) }}
      >
        <button
          type="button"
          aria-label={strings.openBot(bot.name)}
          className="absolute inset-0 rounded-md outline-none"
          onClick={() => void openBot()}
        />
        <span
          className={cn(
            "pointer-events-none relative flex min-w-0 flex-1 items-center gap-2 self-stretch py-1",
            SIDEBAR_HOVER_ACTIONS_INSET_CLASS,
          )}
          style={ONE_ACTION_INSET}
        >
          <BotAvatar bot={bot} conversations={conversations} />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="bb-thread-title min-w-0 truncate" title={bot.name}>
                {bot.name}
              </span>
              {hasChildren ? (
                <SidebarChildToggleChevron
                  isCollapsed={isCollapsed}
                  expandLabel={strings.expand(bot.name)}
                  collapseLabel={strings.collapse(bot.name)}
                  onToggle={onToggle}
                  revealOnHover={!isCollapsed}
                />
              ) : null}
            </span>
            {dropPlace !== null ? (
              <span className={cn("min-w-0 truncate text-xs leading-4", SIDEBAR_GROUP_TEXT_CLASS)}>
                {dropPlace === "first" ? strings.dropFirst(dropCount) : strings.dropLast(dropCount)}
              </span>
            ) : bot.role === "" ? null : (
              <span
                data-1ma-bot-role=""
                title={bot.role}
                className={cn("min-w-0 truncate text-xs leading-4", SIDEBAR_GROUP_TEXT_CLASS)}
              >
                {bot.role}
              </span>
            )}
          </span>
        </span>
        <div
          data-sidebar-hover-actions-open={menuOpen ? "true" : undefined}
          data-sidebar-hover-actions-mobile={SIDEBAR_HOVER_ACTIONS_MOBILE_ALWAYS_VALUE}
          className={cn(
            SIDEBAR_HOVER_ACTIONS_CLASS,
            "absolute inset-y-0 right-0 z-10 flex items-center justify-end",
          )}
        >
          <SidebarRowControls
            primaryAction={
              <SidebarControlButton
                label={strings.newConversation(bot.name)}
                icon={NEW_ICON}
                onClick={() => setComposing(true)}
              />
            }
          >
            <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={strings.botActions(bot.name)}
                  className={SIDEBAR_CONTROL_BUTTON_CLASS}
                >
                  <Icon name="MoreHorizontal" className={COARSE_POINTER_ICON_SIZE_CLASS} />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="right" align="start" sideOffset={8}>
                <DropdownMenuItem onSelect={() => setComposing(true)}>
                  <Icon name={NEW_ICON} />
                  {strings.newConversationItem}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={onOpenBotsPage}>
                  <Icon name="Settings" />
                  {strings.botSettings}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => onSetHidden(!bot.hidden)}>
                  <Icon name={bot.hidden ? "Eye" : "EyeOff"} />
                  {bot.hidden ? strings.showBot : strings.hideBot}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarRowControls>
        </div>
      </div>
      {hasChildren && !isCollapsed ? (
        <div className="relative space-y-px">
          <ThreadTreeGroupLine parentRowDepth={0} />
          {open.length > 0 ? <BotThreadTree bot={bot} threads={open} {...treeProps} /> : null}
          {doneCount > 0 ? (
            <button
              type="button"
              className={cn(
                SIDEBAR_ROW_BASE_CLASS,
                COARSE_POINTER_ROW_HEIGHT_CLASS,
                SIDEBAR_ROW_INTERACTIVE_STATE_CLASS,
                "w-full gap-1 text-xs",
                SIDEBAR_GROUP_TEXT_CLASS,
              )}
              style={{ paddingLeft: getSidebarThreadRowPaddingLeft(1) }}
              aria-expanded={showDone}
              onClick={() => setShowDone(!showDone)}
            >
              {strings.done(doneCount)}
              <Icon
                name="ChevronRight"
                className={cn("size-3 transition-transform duration-150", showDone && "rotate-90")}
              />
            </button>
          ) : null}
          {showDone && doneCount > 0 ? (
            <BotThreadTree bot={bot} threads={done} {...treeProps} />
          ) : null}
        </div>
      ) : null}
      <NewBotConversation bot={bot} open={composing} onOpenChange={setComposing} />
    </div>
  );
}

function NewBotConversation({
  bot,
  open,
  onOpenChange,
}: {
  bot: BotSummary;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const navigate = useBbNavigate();
  const start = useRpcMutation({
    contract: botsRpc,
    pluginId: BOTS_PLUGIN_ID,
    method: "bots.v1.startThread",
  });
  const detail = useRpcQuery({
    contract: botsRpc,
    pluginId: BOTS_PLUGIN_ID,
    method: "bots.v1.get",
    input: { botId: bot.id },
    enabled: open,
  });
  const defaults = detail.data?.defaults ?? null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogTitle>{strings.newConversation(bot.name)}</DialogTitle>
        {open && !detail.isLoading ? (
          <div className="h-80">
            <NewThreadComposer
              draftKey={`1ma-bots:${bot.id}`}
              defaultProjectId={defaults?.projectId ?? undefined}
              defaultProviderId={defaults?.providerId}
              defaultModel={defaults?.model}
              placeholder={strings.composerPlaceholder(bot.name)}
              onSubmit={async (request) => {
                const { threadId } = await start.mutate({ botId: bot.id, request: { ...request } });
                onOpenChange(false);
                navigate.toThread(threadId);
              }}
            />
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
