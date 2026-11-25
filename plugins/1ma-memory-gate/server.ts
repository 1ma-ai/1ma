import { cliCommand, defineCli, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { memoryHostContract } from "./contract.js";
import {
  createGate,
  freeBytes,
  hostLabel,
  isNewTurnOnHost,
  READING_GRACE_MS,
  type Answer,
  type DispatchQuestion,
  type Due,
  type GateSettings,
  type RunningThread,
  type Sample,
} from "./gate.js";
import { withDeadline } from "./deadline.js";
import { createSampler, READ_TIMEOUT_MS } from "./sampler.js";
import { strings } from "./strings.js";

export const SAMPLER_NAME = "memory-sampler";

const RUNNING_TIMEOUT_MS = 2_000;
const MAX_STATUS_HOSTS = 50;

const DEFAULTS = { enabled: true, reserveMb: 600, pressurePercent: 10, minRunning: 1 };
const reserveMbSchema = z.number().int().min(64).max(65536);
const pressurePercentSchema = z.number().int().min(1).max(100);
const minRunningSchema = z.number().int().min(0).max(100);

const storedSettingsSchema = z.object({
  enabled: z.boolean().catch(DEFAULTS.enabled),
  reserveMb: reserveMbSchema.catch(DEFAULTS.reserveMb),
  pressurePercent: pressurePercentSchema.catch(DEFAULTS.pressurePercent),
  minRunning: minRunningSchema.catch(DEFAULTS.minRunning),
});

type StoredSettings = z.infer<typeof storedSettingsSchema>;

function gateSettings(stored: StoredSettings): GateSettings {
  return {
    enabled: stored.enabled,
    reserveBytes: stored.reserveMb * 2 ** 20,
    pressurePercent: stored.pressurePercent,
    minRunning: stored.minRunning,
  };
}

const monotonic = () => performance.now();

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readingLine(sample: Sample | undefined, neededBytes: number): string {
  if (sample === undefined || sample.reading === null) return strings.statusNoReading;
  if (!sample.reading.supported) return strings.statusUnsupported;
  return strings.statusReading(
    freeBytes(sample.reading),
    neededBytes,
    sample.reading.pressureFullAvg10,
    Math.max(0, Math.round((monotonic() - sample.takenAt) / 1000)),
  );
}

export default function plugin(bb: BbPluginApi): void {
  const settings = bb.settings.define({
    enabled: {
      type: "boolean",
      label: strings.enabledLabel,
      description: strings.enabledDescription,
      default: DEFAULTS.enabled,
    },
    reserveMb: {
      type: "number",
      label: strings.reserveMbLabel,
      description: strings.reserveMbDescription,
      experimental_schema: reserveMbSchema,
      default: DEFAULTS.reserveMb,
    },
    pressurePercent: {
      type: "number",
      label: strings.pressurePercentLabel,
      description: strings.pressurePercentDescription,
      experimental_schema: pressurePercentSchema,
      default: DEFAULTS.pressurePercent,
    },
    minRunning: {
      type: "number",
      label: strings.minRunningLabel,
      description: strings.minRunningDescription,
      experimental_schema: minRunningSchema,
      default: DEFAULTS.minRunning,
    },
  });
  const lifetime = new AbortController();
  bb.onDispose(() => lifetime.abort());
  const client = bb.hosts.experimental_client({ contract: memoryHostContract });
  const gate = createGate(monotonic);
  const sampler = createSampler({
    now: monotonic,
    connectedHosts: async (signal) =>
      (await bb.sdk.hosts.list({ signal }))
        .filter((host) => host.status === "connected")
        .map((host) => ({ id: host.id, name: host.name })),
    read: (hostId, signal) =>
      client.call("readMemory", null, { hostId, signal, timeoutMs: READ_TIMEOUT_MS }),
    warn: (message) => bb.log.warn(message),
    changed: () => reconsider(),
  });

  async function currentSettings(): Promise<StoredSettings> {
    return storedSettingsSchema.parse(await settings.get());
  }

  async function runningThreads(): Promise<RunningThread[]> {
    const running = await withDeadline(
      (signal) => bb.sdk.threads.listRunning({ signal }),
      lifetime.signal,
      RUNNING_TIMEOUT_MS,
    ).answer;
    return running.map((thread) => ({ id: thread.id, hostId: thread.hostId }));
  }

  function noteReadings(host: string, readings: Answer["readings"]): void {
    if (readings === "lost") bb.log.warn(strings.logReadingsLost(host, READING_GRACE_MS / 1000));
    if (readings === "back") bb.log.info(strings.logReadingsBack(host));
  }

  // Each failure is warned about once until the call works again.
  let recheckFailing = false;
  let checkFailing = false;

  async function recheck(): Promise<boolean> {
    if (lifetime.signal.aborted) return false;
    try {
      await bb.experimental_hooks.recheck("message.dispatch");
      recheckFailing = false;
      return true;
    } catch (error) {
      if (!lifetime.signal.aborted && !recheckFailing)
        bb.log.warn(strings.logRecheckFailed(errorMessage(error)));
      recheckFailing = true;
      return false;
    }
  }

  async function reconsiderOnce(): Promise<void> {
    for (const hostId of gate.readingsBack(sampler))
      noteReadings(hostLabel({ id: hostId, name: sampler.name(hostId) ?? "" }), "back");
    if (!gate.hasWaiting()) return;
    let due: Due;
    try {
      const [stored, running] = await Promise.all([currentSettings(), runningThreads()]);
      due = gate.due(gateSettings(stored), sampler, running);
      checkFailing = false;
    } catch (error) {
      if (lifetime.signal.aborted) return;
      // The hook lets turns through when it cannot check; the waiting ones get the same chance.
      if (!checkFailing) bb.log.warn(strings.logReconsiderFailed(errorMessage(error)));
      checkFailing = true;
      due = gate.allWaiting();
    }
    if (due.size === 0 || lifetime.signal.aborted) return;
    if (await recheck()) gate.rechecked(due);
  }

  let reconsidering = false;
  let reconsiderAgain = false;

  /** Asks core to re-attempt held turns when one of them would go ahead now. */
  function reconsider(): void {
    if (lifetime.signal.aborted) return;
    if (reconsidering) {
      reconsiderAgain = true;
      return;
    }
    reconsidering = true;
    void (async () => {
      try {
        do {
          reconsiderAgain = false;
          await reconsiderOnce();
        } while (reconsiderAgain && !lifetime.signal.aborted);
      } finally {
        reconsidering = false;
      }
    })();
  }

  // A chat can have further messages held under this plugin's name that the
  // gate was not asked about again, and core's own drain at the end of a turn
  // leaves held messages out: every thread that ends asks for a re-attempt.
  function threadEnded(threadId: string, removed: boolean): void {
    if (removed) gate.removed(threadId);
    else gate.ended(threadId);
    if (gate.hasWaiting()) sampler.requestRefresh();
    void recheck();
  }

  bb.background.service(SAMPLER_NAME, {
    async start(signal) {
      const unsubscribe = bb.sdk.subscribe({
        event: "host:changed",
        callback: (event) => {
          if (!event.changes.includes("host-connected")) return;
          if (event.id === undefined) sampler.requestRefresh();
          else sampler.reconnected(event.id);
        },
      });
      // Turns an earlier instance held are asked about again, so the waiting set rebuilds.
      void recheck();
      try {
        await sampler.run(signal);
      } finally {
        unsubscribe();
      }
    },
  });

  settings.onChange(() => reconsider());
  bb.events.on("thread.idle", ({ thread }) => threadEnded(thread.id, false));
  bb.events.on("thread.failed", ({ thread }) => threadEnded(thread.id, false));
  bb.events.on("thread.archived", ({ thread }) => threadEnded(thread.id, true));
  bb.events.on("thread.deleted", ({ thread }) => threadEnded(thread.id, true));
  bb.events.on("thread.active", ({ thread }) => gate.active(thread.id));
  bb.events.on("message.queued", ({ entry }) => gate.queued(entry.threadId));
  bb.events.on("message.dispatched", ({ entry }) => gate.dispatched(entry.threadId));
  bb.events.on("message.cancelled", ({ entry }) => {
    gate.cancelled(entry.threadId);
    reconsider();
  });

  bb.experimental_hooks.on("message.dispatch", async (context) => {
    const threadId = context.thread.id;
    try {
      const question: DispatchQuestion = {
        attempt: context.attempt,
        threadId,
        threadStatus: context.thread.status,
        host: context.host === null ? null : { id: context.host.id, name: context.host.name },
      };
      if (!isNewTurnOnHost(question)) {
        gate.passed(threadId);
        return { action: "proceed" };
      }
      const stored = await currentSettings();
      if (!stored.enabled) {
        gate.passed(threadId);
        return { action: "proceed" };
      }
      const running = await runningThreads();
      const answer = gate.answer({
        question,
        settings: gateSettings(stored),
        sample: sampler.get(question.host.id),
        running,
      });
      noteReadings(hostLabel(question.host), answer.readings);
      if (answer.action === "proceed") return { action: "proceed" };
      if (answer.why === "no-reading") sampler.requestRefresh();
      return { action: "wait", reason: answer.reason };
    } catch (error) {
      gate.passed(threadId);
      if (!lifetime.signal.aborted) bb.log.warn(strings.logCheckFailed(errorMessage(error)));
      return { action: "proceed" };
    }
  });

  bb.cli.register(
    defineCli({
      name: "memory-gate",
      summary: strings.cliSummary,
      description: strings.cliDescription,
      commands: {
        status: cliCommand({
          summary: strings.statusSummary,
          options: { json: { type: "boolean", description: strings.jsonOption } },
          async run(input) {
            const stored = await currentSettings();
            const [hosts, listed] = await Promise.all([
              bb.sdk.hosts.list(),
              bb.sdk.threads.listRunning(),
            ]);
            const running = listed.map((thread) => ({ id: thread.id, hostId: thread.hostId }));
            const hiddenHosts = Math.max(0, hosts.length - MAX_STATUS_HOSTS);
            const shown = hosts.slice(0, MAX_STATUS_HOSTS).map((host) => {
              const gateHost = { id: host.id, name: hostLabel({ id: host.id, name: host.name }) };
              const sample = sampler.get(host.id);
              const verdict = gate.preview({
                question: {
                  attempt: "start-turn",
                  threadId: "",
                  threadStatus: "idle",
                  host: gateHost,
                },
                settings: gateSettings(stored),
                sample,
                running,
              });
              return {
                host: gateHost,
                status: host.status,
                sample,
                neededBytes: gate.neededBytes(host.id, gateSettings(stored), running),
                waiting: gate.waitingOn(host.id),
                verdict,
              };
            });
            if (input.options.json)
              return {
                exitCode: 0,
                stdout: JSON.stringify({
                  settings: stored,
                  hosts: shown.map(({ host, status, sample, neededBytes, waiting, verdict }) => ({
                    id: host.id,
                    name: host.name,
                    status,
                    reading: sample?.reading ?? null,
                    ageMs:
                      sample === undefined || sample.reading === null
                        ? null
                        : Math.round(monotonic() - sample.takenAt),
                    neededBytes,
                    waiting,
                    answer:
                      verdict.action === "proceed"
                        ? { action: "start", why: verdict.why }
                        : { action: "wait", why: verdict.why, reason: verdict.reason },
                  })),
                  hiddenHosts,
                }),
              };
            const lines = shown.map(({ host, status, sample, neededBytes, waiting, verdict }) =>
              strings.statusHostLine(
                host.name,
                status,
                readingLine(sample, neededBytes),
                verdict.action === "wait"
                  ? strings.statusWait(verdict.reason)
                  : verdict.why === "reading-unavailable"
                    ? strings.statusStartUnchecked
                    : strings.statusStart,
                strings.statusWaiting(waiting),
              ),
            );
            return {
              exitCode: 0,
              stdout: [
                strings.statusSettings(
                  stored.enabled,
                  stored.reserveMb,
                  stored.pressurePercent,
                  stored.minRunning,
                ),
                ...(lines.length === 0 ? [strings.statusNoHosts] : lines),
                ...(hiddenHosts > 0 ? [strings.statusMoreHosts(hiddenHosts)] : []),
              ].join("\n"),
            };
          },
        }),
      },
    }),
  );
}
