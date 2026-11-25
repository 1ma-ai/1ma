function gigabytes(bytes: number): string {
  return (Math.max(0, bytes) / 2 ** 30).toFixed(1);
}

export const strings = {
  enabledLabel: "Wait for free memory",
  enabledDescription:
    "Hold a new chat turn in the queue while its machine is short of memory. A running chat is never stopped, and Send now still sends at once.",
  reserveMbLabel: "Memory per chat (MB)",
  reserveMbDescription:
    "How much free memory a new chat turn needs, 64 to 65536 MB. Each chat let through holds this much more until its own memory shows: until its turn starts, for up to 2 minutes, and for 45 seconds after that. One that another check holds in the queue holds nothing.",
  pressurePercentLabel: "Memory pressure limit (%)",
  pressurePercentDescription:
    "Hold new turns while tasks on the machine spent at least this share of the last 10 seconds waiting for memory, 1 to 100.",
  minRunningLabel: "Always allow this many chats",
  minRunningDescription:
    "Let a new turn start without checking memory, even before the first reading, while fewer chats than this run or are starting on its machine, 0 to 100. Memory held by something other than chats then never stops the only chat.",

  waitingForReading: (host: string) => `Checking free memory on ${host}`,
  waitingForMemory: (host: string) => `Waiting for free memory on ${host}`,
  waitingForPressure: (host: string) => `Waiting for memory pressure on ${host} to ease`,

  logReadingsLost: (host: string, seconds: number) =>
    `no memory reading from ${host} for ${String(seconds)} s, new turns there go ahead unchecked`,
  logReadingsBack: (host: string) =>
    `memory readings from ${host} are back, new turns there are checked again`,
  logCheckFailed: (error: string) => `memory check failed, the turn goes ahead: ${error}`,
  logReconsiderFailed: (error: string) =>
    `could not check held turns, asking to re-attempt them: ${error}`,
  logRecheckFailed: (error: string) => `could not re-attempt held turns: ${error}`,
  logReadFailed: (host: string, error: string, delaySeconds: number) =>
    `could not read memory on ${host}: ${error}; next try in ${String(delaySeconds)} s`,
  logListFailed: (error: string) =>
    `could not list machines: ${error}; readings age until the list is back`,

  cliSummary: "Show whether new chats wait for memory",
  cliDescription:
    "A new chat turn waits in the queue while its machine is short of free memory. A running chat is never stopped; Send now bypasses the wait.",
  statusSummary: "Show the memory reading and the answer for a new chat on each machine",
  jsonOption: "Emit machine-readable JSON",
  statusSettings: (
    enabled: boolean,
    reserveMb: number,
    pressurePercent: number,
    minRunning: number,
  ) =>
    `Memory gate: ${enabled ? "on" : "off"}; ${String(reserveMb)} MB per chat; pressure limit ${String(pressurePercent)}%; always allow ${String(minRunning)}`,
  statusNoHosts: "No machines",
  statusNoReading: "no reading yet",
  statusUnsupported: "no memory gate on this machine (not Linux)",
  statusReading: (
    freeBytes: number | null,
    neededBytes: number,
    pressure: number | null,
    ageSeconds: number,
  ) =>
    `${freeBytes === null ? "free memory unknown" : `${gigabytes(freeBytes)} GB free`}, ${gigabytes(neededBytes)} GB needed for a new chat, pressure ${pressure === null ? "unknown" : `${String(pressure)}%`}, read ${String(ageSeconds)} s ago`,
  statusStart: "a new chat starts",
  statusStartUnchecked: "a new chat starts unchecked: no memory reading",
  statusWait: (reason: string) => `a new chat waits: ${reason}`,
  statusWaiting: (count: number) =>
    count === 1 ? "1 turn waits here" : `${String(count)} turns wait here`,
  statusHostLine: (
    name: string,
    status: string,
    reading: string,
    answer: string,
    waiting: string,
  ) => `${name} (${status}): ${reading}; ${answer}; ${waiting}`,
  statusMoreHosts: (count: number) => `…and ${String(count)} more machines`,
} as const;
