import type { MemoryReading } from "./contract.js";

export const MEMORY_FILES = {
  cgroupMax: "/sys/fs/cgroup/memory.max",
  cgroupHigh: "/sys/fs/cgroup/memory.high",
  cgroupCurrent: "/sys/fs/cgroup/memory.current",
  cgroupStat: "/sys/fs/cgroup/memory.stat",
  cgroupPressure: "/sys/fs/cgroup/memory.pressure",
  meminfo: "/proc/meminfo",
  machinePressure: "/proc/pressure/memory",
} as const;

/** Resolves to null when the file is missing, unreadable or too large. */
export type ReadFile = (path: string) => Promise<string | null>;

function wholeNumber(text: string): number | null {
  if (!/^\d+$/u.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
}

function cgroupLimit(text: string | null): number | "unlimited" | null {
  if (text === null) return null;
  const value = text.trim();
  if (value === "max") return "unlimited";
  return wholeNumber(value) ?? (/^\d+$/u.test(value) ? "unlimited" : null);
}

// Every line in these files ends with a newline; a last line without one was
// cut off mid-read and may hold half a number.
function completeLines(text: string): string[] {
  const end = text.lastIndexOf("\n");
  return end === -1 ? [] : text.slice(0, end).split("\n");
}

function statField(text: string | null, name: string): number | null {
  if (text === null) return null;
  for (const line of completeLines(text)) {
    const [key, value, ...rest] = line.trim().split(/\s+/u);
    if (key === name && value !== undefined && rest.length === 0) return wholeNumber(value);
  }
  return null;
}

function memAvailableBytes(text: string | null): number | null {
  if (text === null) return null;
  for (const line of completeLines(text)) {
    const match = /^MemAvailable:\s+(\d+) kB$/u.exec(line.trim());
    if (match?.[1] !== undefined) {
      const kib = wholeNumber(match[1]);
      return kib === null || !Number.isSafeInteger(kib * 1024) ? null : kib * 1024;
    }
  }
  return null;
}

function fullAvg10(text: string | null): number | null {
  if (text === null) return null;
  for (const line of completeLines(text)) {
    const match = /^full avg10=(\d{1,3}\.\d{2}) /u.exec(line.trim() + " ");
    if (match?.[1] !== undefined) {
      const value = Number(match[1]);
      return value <= 100 ? value : null;
    }
  }
  return null;
}

/** A memory reading of this machine from Linux kernel files, never throwing. */
export async function readMemory(read: ReadFile): Promise<MemoryReading> {
  const [max, high, current, stat, cgroupPressure, meminfo, machinePressure] = await Promise.all(
    [
      MEMORY_FILES.cgroupMax,
      MEMORY_FILES.cgroupHigh,
      MEMORY_FILES.cgroupCurrent,
      MEMORY_FILES.cgroupStat,
      MEMORY_FILES.cgroupPressure,
      MEMORY_FILES.meminfo,
      MEMORY_FILES.machinePressure,
    ].map((path) => read(path).catch(() => null)),
  );
  const limits = [cgroupLimit(max ?? null), cgroupLimit(high ?? null)].filter(
    (limit): limit is number => typeof limit === "number",
  );
  const limitBytes = limits.length === 0 ? null : Math.min(...limits);
  const currentBytes = current == null ? null : wholeNumber(current.trim());
  const inactiveFile = statField(stat ?? null, "inactive_file") ?? 0;
  const cgroup =
    limitBytes === null || currentBytes === null
      ? null
      : { limitBytes, workingSetBytes: Math.max(0, currentBytes - inactiveFile) };
  const machineAvailableBytes = memAvailableBytes(meminfo ?? null);
  if (cgroup === null && machineAvailableBytes === null) return { supported: false };
  return {
    supported: true,
    cgroup,
    machineAvailableBytes,
    pressureFullAvg10: fullAvg10(cgroupPressure ?? null) ?? fullAvg10(machinePressure ?? null),
  };
}
