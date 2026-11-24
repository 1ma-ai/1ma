function gigabytes(bytes: number): string {
  return (Math.max(0, bytes) / 2 ** 30).toFixed(1);
}

export const strings = {
  enabledLabel: "Wait for free memory",
  enabledDescription:
    "Hold a new chat turn in the queue while its machine is short of memory. A running chat is never stopped, and Send now still sends at once.",
  reserveMbLabel: "Memory per chat (MB)",
  reserveMbDescription:
    "How much free memory a new chat turn needs, 64 to 65536 MB. Each chat admitted in the last 45 seconds holds this much more, until its own memory shows.",
  pressurePercentLabel: "Memory pressure limit (%)",
  pressurePercentDescription:
    "Hold new turns while tasks on the machine spent at least this share of the last 10 seconds waiting for memory, 1 to 100.",
  minRunningLabel: "Always allow this many chats",
  minRunningDescription:
    "Let a new turn start without checking memory while fewer chats than this run on its machine, 0 to 100. Memory held by something other than chats then never stops the only chat.",

  waitingForReading: (host: string) => `Checking free memory on ${host}`,
  waitingForMemory: (host: string, freeBytes: number, neededBytes: number) =>
    `Waiting for memory on ${host}: ${gigabytes(freeBytes)} GB free, ${gigabytes(neededBytes)} GB needed`,
  waitingForPressure: (host: string, percent: number) =>
    `Waiting for memory on ${host}: memory pressure ${String(Math.round(percent))}%`,

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
  statusUnsupported: "no memory gate on this machine (no Linux memory files)",
  statusReading: (freeBytes: number | null, pressure: number | null, ageSeconds: number) =>
    `${freeBytes === null ? "free memory unknown" : `${gigabytes(freeBytes)} GB free`}, pressure ${pressure === null ? "unknown" : `${String(pressure)}%`}, read ${String(ageSeconds)} s ago`,
  statusStart: "a new chat starts",
  statusWait: (reason: string) => `a new chat waits: ${reason}`,
  statusHostLine: (name: string, status: string, reading: string, answer: string) =>
    `${name} (${status}): ${reading}; ${answer}`,
  statusMoreHosts: (count: number) => `…and ${String(count)} more machines`,
} as const;
