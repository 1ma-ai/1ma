import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useAtom, useAtomValue } from "jotai";
import {
  experimental_NewThreadComposer as NewThreadComposer,
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
import {
  useHiddenThreadsStatus,
  usePluginThreadRowStatusForThreads,
} from "../app/list/groupRollups.js";
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
  const visible = useMemo(() => state.bots.filter((bot) => !bot.hidden), [state.bots]);
  const conversations = useBotConversations(visible);
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
        collapsedThreads={conversations.allOpen}
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
          visible.map((bot) => (
            <BotRow
              key={bot.id}
              bot={bot}
              conversations={conversations.of(bot)}
              collapsed={collapsed.includes(bot.id)}
              onToggle={() => toggle(bot.id)}
              onOpenBotsPage={openBotsPage}
              selectedThreadId={selectedThreadId}
              onProjectSelect={onProjectSelect}
              tree={tree}
            />
          ))
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
  openRoots: PluginSidebarThread[];
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
        openRoots: present(open),
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
      openRoots: [],
      doneCount: 0,
      compare: () => 0,
    };
    return {
      of: (bot: SidebarBot) => byBot.get(bot.id) ?? empty,
      allOpen: [...byBot.values()].flatMap((item) => item.open),
    };
  }, [bots, threads]);
}

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
  selectedThreadId,
  onProjectSelect,
  tree,
}: {
  bot: SidebarBot;
  conversations: BotConversations;
  collapsed: boolean;
  onToggle: () => void;
  onOpenBotsPage: () => void;
  selectedThreadId?: string;
  onProjectSelect?: () => void;
  tree: TreeState;
}) {
  const navigate = useBbNavigate();
  const [showDone, setShowDone] = useState(false);
  const [composing, setComposing] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const { first, open, done, doneCount, compare, openRoots } = conversations;
  const hasChildren = open.length > 0 || doneCount > 0;
  const isCollapsed = collapsed && hasChildren;
  const pluginStatus = usePluginThreadRowStatusForThreads(openRoots);
  const status = useHiddenThreadsStatus(openRoots, pluginStatus);
  const label = bot.role === "" ? bot.name : `${bot.name} — ${bot.role}`;

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
        className={cn(
          SIDEBAR_HOVER_ACTIONS_ROW_CLASS,
          "group/thread-row relative cursor-pointer",
          SIDEBAR_ROW_BASE_CLASS,
          LIST_HOVER_TRANSITION,
          COARSE_POINTER_ROW_HEIGHT_CLASS,
          "h-auto min-h-[var(--bb-sidebar-row-height)] max-md:pointer-coarse:h-auto max-md:pointer-coarse:min-h-[var(--bb-sidebar-row-height-coarse)]",
          SIDEBAR_ROW_INTERACTIVE_STATE_CLASS,
          SIDEBAR_ROW_ACCENT_STATE_CLASS,
          menuOpen && "bg-sidebar-accent",
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
          <span className="relative shrink-0" data-1ma-bot-avatar="">
            <img src={bot.avatar} alt="" className="size-8 rounded-full" />
            {status.indicator === "none" && status.rowStatus === null ? null : (
              <span className="absolute -right-1 -bottom-1 flex items-center justify-center rounded-full bg-sidebar">
                <ThreadStatusGlyph indicator={status.indicator} rowStatus={status.rowStatus} />
              </span>
            )}
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="bb-thread-title min-w-0 truncate" title={label}>
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
            {first === null ? null : (
              <span
                data-1ma-bot-main-conversation=""
                className={cn("min-w-0 truncate text-xs leading-4", SIDEBAR_GROUP_TEXT_CLASS)}
              >
                {first.displayTitle}
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
                <DropdownMenuItem onSelect={onOpenBotsPage}>
                  <Icon name="Settings" />
                  {strings.botSettings}
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
