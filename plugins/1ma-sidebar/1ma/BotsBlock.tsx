import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useAtom, useAtomValue } from "jotai";
import {
  experimental_NewThreadComposer as NewThreadComposer,
  experimental_resolveThreadStatus as resolveThreadStatus,
  experimental_ThreadStatusGlyph as ThreadStatusGlyph,
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
import { ProjectThreadTree, ThreadTreeGroupLine } from "../app/list/ProjectRow.js";
import { TopLevelSidebarSection } from "../app/list/TopLevelSidebarSection.js";
import type { ThreadComparator } from "../app/model/project-thread-groups.js";
import { sidebarThreadLifecyclesAtom } from "../app/preferences/atoms.js";
import { createSyncedPreferenceAtom } from "../app/preferences/synced-preference-atom.js";
import { SidebarChildToggleChevron } from "../app/rows/SidebarChildToggleChevron.js";
import { SidebarControlButton, SidebarRowControls } from "../app/rows/SidebarRowControls.js";
import { BOTS_PLUGIN_ID, botsRpc, type SidebarBot } from "./bots-rpc.js";
import { threadsShownUnderBots } from "./bot-threads.js";
import { strings } from "./strings.js";
import { useSidebarBots } from "./use-bots.js";
import {
  BOT_DROP_FIRST_ATTRIBUTE,
  BOT_DROP_TARGET_ATTRIBUTE,
  botDrop,
  useBotDropCount,
  useBotDropTarget,
  type BotDropHandler,
} from "./thread-drop.js";
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

export function BotsBlock({ selectedThreadId, onProjectSelect, ...tree }: BotsBlockProps) {
  const state = useSidebarBots();
  const navigation = useSidebarNavigation();
  const [collapsed, setCollapsed] = useAtom(collapsedBotsAtom);
  const toggle = (key: string) =>
    setCollapsed((current) =>
      current.includes(key) ? current.filter((item) => item !== key) : [...current, key],
    );
  const [showHidden, setShowHidden] = useState(false);
  const visible = useMemo(() => state.bots.filter((bot) => !bot.hidden), [state.bots]);
  const hidden = useMemo(() => state.bots.filter((bot) => bot.hidden), [state.bots]);
  const conversations = useBotConversations(state.bots);
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
        void (async () => {
          const moved: string[] = [];
          let failure: unknown = null;
          for (const threadId of ordered) {
            try {
              await assign.mutate({ threadId, botId: bot.id, place: target.place });
              moved.push(threadId);
            } catch (error) {
              failure = error;
              break;
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
          if (failure === null) {
            toast.success(strings.assigned(bot.name, moved.length), { action: open });
            return;
          }
          const reason = getMutationErrorMessage({
            error: failure,
            fallbackMessage: strings.assignFailed(bot.name),
          });
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
    [],
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
  const openBotsPage = () => navigation.actions.activate(panelId, { target: "current" });
  return (
    <div className="pb-4" data-1ma-bots-block="">
      <TopLevelSidebarSection
        label={strings.title}
        sectionId="1ma-bots"
        collapseControl={{
          isCollapsed: collapsed.includes(BLOCK_KEY),
          onToggleCollapsed: () => toggle(BLOCK_KEY),
        }}
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

const RUNNING: ReadonlySet<string> = new Set(["starting", "active", "stopping"]);

interface BotConversations {
  // The conversation the bot row opens: its first open one.
  first: PluginSidebarThread | null;
  // Open and done conversations with their sub-threads.
  open: PluginSidebarThread[];
  done: PluginSidebarThread[];
  doneCount: number;
  compare: ThreadComparator;
}

function useBotConversations(bots: readonly SidebarBot[]) {
  const lifecycles = useAtomValue(sidebarThreadLifecyclesAtom);
  const { threads } = useSidebarThreads({ experimental_lifecycles: lifecycles });
  return useMemo(() => {
    const byId = new Map(threads.map((thread) => [thread.id, thread]));
    const subtree = (bot: SidebarBot, roots: readonly string[]) => {
      const shown = threadsShownUnderBots(
        [
          {
            ...bot,
            hidden: false,
            threads: roots.map((threadId) => ({
              threadId,
              startedFromBot: true,
              completed: false,
            })),
          },
        ],
        threads,
      );
      return threads.filter((thread) => shown.has(thread.id));
    };
    const byBot = new Map<string, BotConversations>();
    for (const bot of bots) {
      const order = new Map(bot.threads.map((thread, index) => [thread.threadId, index]));
      // A done conversation that is working again shows with the open ones;
      // 1ma-bots clears the done mark once the turn has really run.
      const isOpen = (item: SidebarBot["threads"][number]) =>
        !item.completed || RUNNING.has(byId.get(item.threadId)?.status ?? "idle");
      const open = bot.threads.filter(isOpen).map((thread) => thread.threadId);
      const done = bot.threads.filter((thread) => !isOpen(thread)).map((thread) => thread.threadId);
      const present = (ids: readonly string[]) =>
        ids.flatMap((id) => {
          const thread = byId.get(id);
          return thread === undefined ? [] : [thread];
        });
      byBot.set(bot.id, {
        first: present(open)[0] ?? null,
        open: subtree(bot, open),
        done: subtree(bot, done),
        doneCount: present(done).length,
        compare: (left, right) =>
          (order.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
            (order.get(right.id) ?? Number.MAX_SAFE_INTEGER) || right.createdAt - left.createdAt,
      });
    }
    const empty: BotConversations = {
      first: null,
      open: [],
      done: [],
      doneCount: 0,
      compare: () => 0,
    };
    return {
      of: (bot: SidebarBot) => byBot.get(bot.id) ?? empty,
      parentOf: (threadId: string) => byId.get(threadId)?.parentThreadId ?? null,
    };
  }, [bots, threads]);
}

// The bot's state at a glance, drawn on its image: the glyph bb draws for its
// main conversation (the one a click opens) on the corner, a dot for each
// other conversation that is working (two and a plus past three, the count in
// the tooltip), and a red mark for an unread error elsewhere.
function BotAvatar({ bot, conversations }: { bot: SidebarBot; conversations: BotConversations }) {
  const { first, open } = conversations;
  const main = useMemo(() => (first === null ? NO_THREADS : [first]), [first]);
  const hasDraft = useThreadsHaveDraft(main);
  const rowStatus = usePluginThreadRowStatusForThreads(main);
  const status = resolveThreadStatus({
    thread: first,
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
    : open.filter((thread) => thread.id !== first?.id && own(thread).isWorking).length;
  const unreadError =
    !quiet &&
    status.indicator !== "unread-error" &&
    open.some((thread) => own(thread).indicator === "unread-error");
  const label = [
    first === null ? null : strings.mainConversationStatus(status.label),
    others > 0 ? strings.othersWorking(others) : null,
    unreadError ? strings.unreadError : null,
  ]
    .filter((part) => part !== null)
    .join("; ");
  const dots = others > 3 ? 2 : others;
  const showMain = !quiet && (status.indicator !== "none" || status.rowStatus !== null);
  return (
    <span
      className="relative shrink-0"
      data-1ma-bot-avatar=""
      {...{ [BOT_DROP_FIRST_ATTRIBUTE]: "" }}
      role="img"
      aria-label={label === "" ? bot.name : `${bot.name}: ${label}`}
      title={label === "" ? undefined : label}
    >
      <img src={bot.avatar} alt="" className="size-8 rounded-full" />
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
  conversations,
  collapsed,
  onToggle,
  onOpenBotsPage,
  onSetHidden,
  selectedThreadId,
  onProjectSelect,
  tree,
}: {
  bot: SidebarBot;
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
  const { first, open, done, doneCount, compare } = conversations;
  // A hidden bot's conversations stay in their projects; shown here, it is
  // only a row to bring it back.
  const hasChildren = !bot.hidden && (open.length > 0 || doneCount > 0);
  const isCollapsed = collapsed && hasChildren;
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

  const openBot = () => {
    if (first === null) {
      setComposing(true);
      return;
    }
    navigate.toThread(first.id);
    onProjectSelect?.();
  };
  const treeProps = {
    compareThreads: compare,
    selectedThreadId,
    onProjectSelect,
    depthOffset: 1,
    ...tree,
  };
  return (
    <div className="relative space-y-0.5" data-bot-id={bot.id}>
      <div
        data-sidebar-rename-row=""
        data-1ma-bot-row=""
        data-1ma-bot-hidden={bot.hidden ? "" : undefined}
        {...{ [BOT_DROP_TARGET_ATTRIBUTE]: bot.hidden ? "" : bot.id }}
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
          onClick={openBot}
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
          {open.length > 0 ? (
            <ProjectThreadTree
              threadListState={{ status: "ready", threads: open }}
              {...treeProps}
            />
          ) : null}
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
            <ProjectThreadTree
              threadListState={{ status: "ready", threads: done }}
              {...treeProps}
            />
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
  bot: SidebarBot;
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
