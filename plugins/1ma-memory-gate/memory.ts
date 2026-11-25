import type { MemoryReading } from "./contract.js";

export const CGROUP_MOUNT = "/sys/fs/cgroup";
export const MEMORY_FILES = {
  selfCgroup: "/proc/self/cgroup",
  mountinfo: "/proc/self/mountinfo",
  meminfo: "/proc/meminfo",
  machinePressure: "/proc/pressure/memory",
} as const;
export const MAX_MOUNTINFO_BYTES = 2 ** 20;
export const MAX_CGROUP_LEVELS = 64;

/** Resolves to null when the file is missing, unreadable or over the bound. */
export type ReadFile = (path: string, maxBytes?: number) => Promise<string | null>;

export type LinuxReading = Extract<MemoryReading, { supported: true }>;
type Budget = NonNullable<LinuxReading["cgroup"]>;

interface Level {
  dir: string;
  readable: boolean;
  budget: Budget | null;
}

async function readOrNull(read: ReadFile, path: string, maxBytes?: number) {
  try {
    return await read(path, maxBytes);
  } catch {
    return null;
  }
}

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

function pathParts(path: string): string[] | null {
  const parts = path.split("/").filter((part) => part !== "");
  return parts.some((part) => part === "." || part === "..") ? null : parts;
}

function joinPath(base: string, parts: readonly string[]): string {
  return parts.length === 0 ? base : `${base === "/" ? "" : base}/${parts.join("/")}`;
}

function ownCgroupPath(text: string | null): string | null {
  if (text === null) return null;
  for (const line of completeLines(text)) if (line.startsWith("0::")) return line.slice(3);
  return null;
}

// mountinfo writes a space, tab, newline or backslash in a path as \ and three octal digits.
function mountField(field: string): string {
  return field.replace(/\\([0-7]{3})/gu, (_escape, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8)),
  );
}

function cgroup2Mounts(text: string | null): { root: string; point: string }[] {
  if (text === null) return [];
  const mounts: { root: string; point: string }[] = [];
  for (const line of completeLines(text)) {
    const fields = line.split(" ");
    const separator = fields.indexOf("-", 6);
    const [root, point] = [fields[3], fields[4]];
    if (separator !== -1 && fields[separator + 1] === "cgroup2" && root && point)
      mounts.push({ root: mountField(root), point: mountField(point) });
  }
  return mounts;
}

/** The process's cgroup directory and its ancestors up to the cgroup2 mount point. */
function cgroupLevels(cgroupFile: string | null, mountinfo: string | null): string[] | null {
  const path = ownCgroupPath(cgroupFile);
  const own = path === null ? null : pathParts(path);
  if (own === null) return null;
  for (const mount of cgroup2Mounts(mountinfo)) {
    const root = pathParts(mount.root);
    if (root === null || root.length > own.length || root.some((part, i) => own[i] !== part))
      continue;
    const relative = own.slice(root.length);
    const levels: string[] = [];
    for (let depth = relative.length; depth >= 0 && levels.length < MAX_CGROUP_LEVELS; depth--)
      levels.push(joinPath(mount.point, relative.slice(0, depth)));
    return levels;
  }
  return null;
}

async function readLevel(read: ReadFile, dir: string): Promise<Level> {
  const [max, high, current, stat] = await Promise.all(
    ["memory.max", "memory.high", "memory.current", "memory.stat"].map((name) =>
      readOrNull(read, `${dir}/${name}`),
    ),
  );
  const limits = [cgroupLimit(max ?? null), cgroupLimit(high ?? null)].filter(
    (limit): limit is number => typeof limit === "number",
  );
  const limitBytes = limits.length === 0 ? null : Math.min(...limits);
  const currentBytes = current == null ? null : wholeNumber(current.trim());
  const inactiveFile = statField(stat ?? null, "inactive_file") ?? 0;
  return {
    dir,
    readable: [max, high, current, stat].some((text) => text != null),
    budget:
      limitBytes === null || currentBytes === null
        ? null
        : { limitBytes, workingSetBytes: Math.max(0, currentBytes - inactiveFile) },
  };
}

function room(budget: Budget): number {
  return budget.limitBytes - budget.workingSetBytes;
}

/** A memory reading of this Linux machine from kernel files, never throwing. */
export async function readMemory(read: ReadFile): Promise<LinuxReading> {
  const [cgroupFile, mountinfo, meminfo, machinePressure] = await Promise.all([
    readOrNull(read, MEMORY_FILES.selfCgroup),
    readOrNull(read, MEMORY_FILES.mountinfo, MAX_MOUNTINFO_BYTES),
    readOrNull(read, MEMORY_FILES.meminfo),
    readOrNull(read, MEMORY_FILES.machinePressure),
  ]);
  const dirs = cgroupLevels(cgroupFile, mountinfo);
  let levels = dirs === null ? [] : await Promise.all(dirs.map((dir) => readLevel(read, dir)));
  // A group the memory controller is not delegated to has no memory files of
  // its own; its ancestors' limits bind it all the same.
  if (!levels.some((level) => level.readable)) levels = [await readLevel(read, CGROUP_MOUNT)];
  const binding = levels
    .filter((level): level is Level & { budget: Budget } => level.budget !== null)
    .reduce<(Level & { budget: Budget }) | null>(
      (least, level) => (least === null || room(level.budget) < room(least.budget) ? level : least),
      null,
    );
  let pressure: number | null = null;
  for (const dir of new Set([binding?.dir, levels[0]?.dir])) {
    if (dir === undefined) continue;
    pressure = fullAvg10(await readOrNull(read, `${dir}/memory.pressure`));
    if (pressure !== null) break;
  }
  return {
    supported: true,
    cgroup: binding?.budget ?? null,
    machineAvailableBytes: memAvailableBytes(meminfo),
    pressureFullAvg10: pressure ?? fullAvg10(machinePressure),
  };
}
