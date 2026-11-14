import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  createAutoUpdates,
  type ProviderTarget,
  type ThreadState,
  type UpdateChoices,
  type UpdateWork,
} from "./auto-updates.js";
import { strings } from "./strings.js";

export const SCHEDULE_NAME = "install-updates";
export const SCHEDULE_CRON = "*/15 * * * *";

const ONE_MA_REPOSITORY = "https://github.com/1ma-ai/1ma";

const threadSchema = z.object({
  status: z.string(),
  activity: z
    .object({
      activeBackgroundAgentCount: z.number().optional(),
      activeBackgroundCommandCount: z.number().optional(),
      activeWorkflowCount: z.number().optional(),
    })
    .nullish(),
});

const providerStatusesSchema = z.record(
  z.string(),
  z.object({ installAction: z.object({ kind: z.string() }).nullish() }),
);

const pluginListSchema = z.object({
  plugins: z.array(
    z.object({
      id: z.string(),
      source: z.string(),
      updateState: z.object({ outcome: z.string() }).nullish(),
    }),
  ),
});

const installEventsSchema = z.array(
  z.object({ type: z.string(), success: z.boolean().optional() }),
);

const appliedSchema = z.object({ applied: z.boolean() });

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(new Error("1ma Auto Updates stopped"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

function threadStates(entries: readonly unknown[]): ThreadState[] | null {
  const states: ThreadState[] = [];
  for (const entry of entries) {
    const parsed = threadSchema.safeParse(entry);
    if (!parsed.success) return null;
    states.push({
      status: parsed.data.status,
      backgroundAgents: parsed.data.activity?.activeBackgroundAgentCount ?? 0,
      backgroundCommands: parsed.data.activity?.activeBackgroundCommandCount ?? 0,
      workflows: parsed.data.activity?.activeWorkflowCount ?? 0,
    });
  }
  return states;
}

function comesFrom1ma(source: string): boolean {
  const spec = source.startsWith("git:") ? source.slice("git:".length) : source;
  if (!spec.startsWith("https://")) return false;
  const at = spec.lastIndexOf("@");
  const url = at > "https://".length ? spec.slice(0, at) : spec;
  return (
    url
      .replace(/\.git$/u, "")
      .replace(/\/$/u, "")
      .toLowerCase() === ONE_MA_REPOSITORY
  );
}

async function findWork(bb: BbPluginApi, choices: UpdateChoices): Promise<UpdateWork> {
  const hosts = choices.providers
    ? (await bb.sdk.hosts.list()).filter(
        (host) => host.status === "connected" && host.type !== "ephemeral",
      )
    : [];
  const perHost = await Promise.all(
    hosts.map(async (host): Promise<ProviderTarget[]> => {
      const statuses = providerStatusesSchema.parse(
        await bb.sdk.hosts.providerCliStatus({ hostId: host.id }),
      );
      return Object.entries(statuses)
        .filter(([, status]) => status.installAction?.kind === "update")
        .map(([providerId]) => ({ hostId: host.id, hostName: host.name, providerId }));
    }),
  );
  const plugins =
    choices.plugins || choices.otherPlugins
      ? pluginListSchema
          .parse(await bb.sdk.plugins.list())
          .plugins.filter((entry) => entry.updateState?.outcome === "update-available")
          .map((entry) => ({ id: entry.id, fromOneMa: comesFrom1ma(entry.source) }))
          .filter((entry) => (entry.fromOneMa ? choices.plugins : choices.otherPlugins))
      : [];
  return { providers: perHost.flat(), plugins };
}

export default function plugin(bb: BbPluginApi): void {
  const settings = bb.settings.define({
    providers: {
      type: "boolean",
      label: strings.providersLabel,
      description: strings.providersDescription,
      default: true,
    },
    plugins: {
      type: "boolean",
      label: strings.pluginsLabel,
      description: strings.pluginsDescription,
      default: true,
    },
    otherPlugins: {
      type: "boolean",
      label: strings.otherPluginsLabel,
      description: strings.otherPluginsDescription,
      default: false,
    },
  });
  const disposed = new AbortController();
  bb.onDispose(() => disposed.abort());

  const updates = createAutoUpdates(
    {
      selfId: bb.pluginId,
      now: () => Date.now(),
      sleep: (ms) => sleep(ms, disposed.signal),
      choices: () => settings.get(),
      threads: async () => {
        try {
          return threadStates(await bb.sdk.threads.list({ includeHidden: true }));
        } catch (error) {
          bb.log.warn(
            `could not list threads: ${error instanceof Error ? error.message : String(error)}`,
          );
          return null;
        }
      },
      findWork: (choices) => findWork(bb, choices),
      installProvider: async ({ hostId, providerId }) =>
        installEventsSchema
          .parse(
            await bb.sdk.hosts.installProviderCli({
              hostId,
              provider: providerId,
              actionKind: "update",
            }),
          )
          .some((event) => event.type === "completed" && event.success === true),
      updatePlugin: async (pluginId) =>
        appliedSchema.parse(await bb.sdk.plugins.applyUpdate({ pluginId })).applied,
      releaseHeld: () => {
        bb.experimental_hooks.recheck("message.dispatch").catch((error: unknown) => {
          bb.log.warn(
            `could not release held messages: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      },
      warn: (message) => bb.log.warn(message),
    },
    strings.holdReason,
  );

  bb.events.on("thread.active", () => updates.noteThreadActivity());
  bb.events.on("thread.idle", () => updates.noteThreadActivity());
  bb.events.on("thread.failed", () => updates.noteThreadActivity());
  bb.experimental_hooks.on("message.dispatch", () => updates.decideDispatch());
  bb.background.schedule(SCHEDULE_NAME, SCHEDULE_CRON, async () => {
    const outcome = await updates.run();
    if (outcome.kind === "attempted")
      bb.log.info(
        `installed: ${outcome.installed.join(", ") || "nothing"}; failed: ${outcome.failed.join(", ") || "nothing"}; postponed because work started: ${outcome.postponed.join(", ") || "nothing"}`,
      );
    else bb.log.debug(`no updates installed: ${outcome.kind}`);
  });
}
