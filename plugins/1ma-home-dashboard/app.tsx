import { useEffect, useMemo, useState } from "react";
import {
  definePluginApp,
  experimental_useRpcQuery,
  experimental_useSidebarThreads,
  useBbNavigate,
  type PluginRpcMethodContract,
  type PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import { z } from "zod";
import { groupThreads, type Lane } from "./grouping";
import { strings } from "./strings";
import { LANE_PAGE, isoTime, page, relativeTime, tasksView } from "./view";

const focusBoard = {
  done_list: {
    input: z.null(),
    output: z.object({
      doneIds: z.array(z.string()),
      records: z.record(
        z.string(),
        z.object({
          doneAt: z.string().optional(),
          keep: z.boolean().optional(),
        }),
      ),
    }),
  },
} satisfies Record<string, PluginRpcMethodContract>;

const LANES: readonly { id: Lane; color: string }[] = [
  { id: "needs-you", color: "bg-amber-400" },
  { id: "done", color: "bg-slate-300" },
  { id: "running", color: "bg-sky-300" },
];

function TaskCard({
  thread,
  onOpen,
  now,
}: {
  thread: PluginSidebarThread;
  onOpen: () => void;
  now: number;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="w-full rounded-lg border border-border bg-card px-3 py-2 text-left text-sm text-foreground transition-colors hover:bg-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
      aria-label={strings.open(thread.displayTitle)}
    >
      <span className="block line-clamp-2 font-medium">{thread.displayTitle}</span>
      <time
        className="mt-1 block text-xs text-muted-foreground"
        dateTime={isoTime(thread.updatedAt)}
        title={strings.lastActivity}
      >
        {relativeTime(thread.updatedAt, now)}
      </time>
    </button>
  );
}

function Tasks({ projectId }: { projectId: string | null }) {
  const { status, threads } = experimental_useSidebarThreads();
  const navigate = useBbNavigate();
  const [now, setNow] = useState(Date.now);
  const [shown, setShown] = useState<Record<Lane, number>>({
    "needs-you": LANE_PAGE,
    done: LANE_PAGE,
    running: LANE_PAGE,
  });
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const doneQuery = experimental_useRpcQuery({
    pluginId: "focus-board",
    contract: focusBoard,
    method: "done_list",
    input: null,
  });

  // Focus Board's older RPC publishes its own realtime event, which another
  // plugin cannot subscribe to. Recheck while this section is mounted and the
  // page is visible, and once more when it becomes visible again.
  const refetchDone = doneQuery.refetch;
  useEffect(() => {
    const refresh = () => {
      if (!document.hidden) void refetchDone();
    };
    const timer = window.setInterval(refresh, 20_000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [refetchDone]);

  const view = useMemo(
    () =>
      tasksView({
        threadsStatus: status,
        done: {
          isLoading: doneQuery.isLoading,
          error: doneQuery.error,
          doneIds: doneQuery.data?.doneIds,
        },
      }),
    [status, doneQuery.isLoading, doneQuery.error, doneQuery.data],
  );
  const doneIds = view.kind === "ready" ? view.doneIds : null;
  const grouped = useMemo(
    () => groupThreads(threads, projectId, doneIds ?? new Set<string>()),
    [threads, projectId, doneIds],
  );

  if (view.kind === "error") {
    return <p className="text-sm text-destructive">{strings.threadsUnavailable}</p>;
  }
  if (view.kind === "loading") {
    return <p className="text-sm text-muted-foreground">{strings.loading}</p>;
  }

  return (
    <div className="space-y-3">
      {view.focusBoardMissing ? (
        <p className="text-sm text-destructive">{strings.focusBoardUnavailable}</p>
      ) : null}
      <div className="grid gap-3 md:grid-cols-3">
        {LANES.map(({ id, color }) => {
          const visible = page(grouped[id], shown[id]);
          return (
            <section key={id} className="min-w-0" aria-label={strings.lanes[id]}>
              <div className="mb-3 flex items-center gap-2">
                <span className={`h-1.5 w-1.5 rounded-full ${color}`} aria-hidden="true" />
                <h3 className="text-sm font-semibold text-foreground">{strings.lanes[id]}</h3>
                <span className="text-xs text-muted-foreground">{grouped[id].length}</span>
              </div>
              <div className="space-y-2 md:max-h-80 md:overflow-y-auto">
                {visible.items.map((thread) => (
                  <TaskCard
                    key={thread.id}
                    thread={thread}
                    now={now}
                    onOpen={() => navigate.toThread(thread.id)}
                  />
                ))}
                {visible.hidden > 0 ? (
                  <button
                    type="button"
                    onClick={() => setShown((old) => ({ ...old, [id]: old[id] + LANE_PAGE }))}
                    className="w-full rounded-lg px-3 py-2 text-left text-xs text-muted-foreground hover:bg-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
                  >
                    {strings.showMore(Math.min(visible.hidden, LANE_PAGE))}
                  </button>
                ) : null}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.homepageSection({ id: "tasks", title: strings.section, component: Tasks });
});
