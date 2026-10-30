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

const LANES: readonly { id: Lane; title: string; color: string }[] = [
  { id: "needs-you", title: "Needs you", color: "bg-amber-400" },
  { id: "done", title: "Done", color: "bg-slate-300" },
  { id: "running", title: "Running", color: "bg-sky-300" },
];

function relativeTime(updatedAt: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - updatedAt) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

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
      aria-label={`Open ${thread.displayTitle}`}
    >
      <span className="block line-clamp-2 font-medium">{thread.displayTitle}</span>
      <time
        className="mt-1 block text-xs text-muted-foreground"
        dateTime={new Date(thread.updatedAt).toISOString()}
        title="Last activity"
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
  // plugin cannot subscribe to. Recheck while this section is mounted.
  const refetchDone = doneQuery.refetch;
  useEffect(() => {
    const timer = window.setInterval(() => {
      void refetchDone();
    }, 20_000);
    return () => window.clearInterval(timer);
  }, [refetchDone]);

  const doneIds = useMemo(() => new Set(doneQuery.data?.doneIds ?? []), [doneQuery.data]);
  const grouped = useMemo(
    () => groupThreads(threads, projectId, doneIds),
    [threads, projectId, doneIds],
  );

  if (status === "error") {
    return <p className="text-sm text-destructive">Треды 1ma недоступны. Обновите страницу.</p>;
  }
  if (status !== "ready" || doneQuery.isLoading) {
    return <p className="text-sm text-muted-foreground">Загружаем задачи…</p>;
  }
  if (doneQuery.error || !doneQuery.data) {
    return (
      <p className="text-sm text-destructive">
        Статус задач Focus Board недоступен. Включите Focus Board и обновите страницу.
      </p>
    );
  }

  return (
    <div className="grid gap-3 md:grid-cols-3">
      {LANES.map(({ id, title, color }) => (
        <section key={id} className="min-w-0" aria-label={title}>
          <div className="mb-3 flex items-center gap-2">
            <span className={`h-1.5 w-1.5 rounded-full ${color}`} aria-hidden="true" />
            <h3 className="text-sm font-semibold text-foreground">{title}</h3>
            <span className="text-xs text-muted-foreground">{grouped[id].length}</span>
          </div>
          <div className="max-h-80 space-y-2 overflow-y-auto">
            {grouped[id].length === 0
              ? null
              : grouped[id].map((thread) => (
                  <TaskCard
                    key={thread.id}
                    thread={thread}
                    now={now}
                    onOpen={() => navigate.toThread(thread.id)}
                  />
                ))}
          </div>
        </section>
      ))}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.homepageSection({ id: "tasks", title: "Tasks", component: Tasks });
});
