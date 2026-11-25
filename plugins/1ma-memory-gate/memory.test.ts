import { expect, it } from "vitest";
import { memoryReadingSchema } from "./contract.js";
import { freeBytes } from "./gate.js";
import { MEMORY_FILES, readMemory } from "./memory.js";

const MIB = 2 ** 20;
const GIB = 2 ** 30;
const MOUNT = "/sys/fs/cgroup";

const MEMORY_STAT = `anon 1836490752
file 2147483648
kernel 104857600
shmem 4096
file_mapped 52428800
active_anon 1700000000
inactive_anon 136490752
active_file 1073741824
inactive_file 1073741824
unevictable 0
pgfault 123456
`;

const PRESSURE_CALM = `some avg10=0.00 avg60=0.00 avg300=0.00 total=1234
full avg10=0.00 avg60=0.00 avg300=0.00 total=567
`;

const PRESSURE_BUSY = `some avg10=31.50 avg60=12.04 avg300=3.10 total=99887766
full avg10=14.25 avg60=6.02 avg300=1.55 total=44332211
`;

const PRESSURE_SOME = `some avg10=8.00 avg60=2.00 avg300=1.00 total=4321
full avg10=3.50 avg60=1.00 avg300=0.50 total=1234
`;

const MEMINFO = `MemTotal:       12582912 kB
MemFree:          524288 kB
MemAvailable:    3145728 kB
Buffers:          102400 kB
Cached:          2097152 kB
`;

function mountLine(root: string, point: string): string {
  return `30 25 0:26 ${root} ${point} rw,nosuid,nodev,noexec,relatime shared:4 - cgroup2 cgroup2 rw,nsdelegate\n`;
}

const OTHER_MOUNTS = `22 1 8:1 / / rw,relatime shared:1 - ext4 /dev/sda1 rw
24 22 0:5 / /dev rw,nosuid shared:2 - devtmpfs udev rw
`;

type GroupFile = "max" | "high" | "current" | "stat" | "pressure";
type Files = Record<string, string | undefined>;

function group(dir: string, contents: Partial<Record<GroupFile, string>>): Files {
  return Object.fromEntries(
    Object.entries(contents).map(([name, text]) => [`${dir}/memory.${name}`, text]),
  );
}

function bytes(value: number): string {
  return `${String(value)}\n`;
}

/** A reader that refuses content over its bound, as the host reader does. */
function reader(files: Files) {
  return async (path: string, maxBytes = 64 * 1024) => {
    const text = files[path];
    return text === undefined || text.length > maxBytes ? null : text;
  };
}

const machine: Files = {
  [MEMORY_FILES.meminfo]: MEMINFO,
  [MEMORY_FILES.machinePressure]: PRESSURE_BUSY,
};

const rootGroup = {
  max: bytes(6 * GIB),
  high: "max\n",
  current: bytes(4 * GIB),
  stat: MEMORY_STAT,
  pressure: PRESSURE_CALM,
};

function container(overrides: Partial<Record<GroupFile, string | undefined>> = {}): Files {
  return { ...machine, ...group(MOUNT, { ...rootGroup, ...overrides }) };
}

/** The process in `path` under a cgroup2 mount at `/sys/fs/cgroup` with mount root `root`. */
function placed(
  path: string,
  root = "/",
  mountinfo = OTHER_MOUNTS + mountLine(root, MOUNT),
): Files {
  return { "/proc/self/cgroup": `0::${path}\n`, "/proc/self/mountinfo": mountinfo };
}

it("reads the container limit, its working set without reclaimable file cache, the machine and the pressure", async () => {
  const reading = await readMemory(reader(container()));
  expect(reading).toEqual({
    supported: true,
    cgroup: { limitBytes: 6 * GIB, workingSetBytes: 4 * GIB - 1073741824 },
    machineAvailableBytes: 3145728 * 1024,
    pressureFullAvg10: 0,
  });
  expect(memoryReadingSchema.safeParse(reading).success).toBe(true);
});

it("takes the lower of memory.high and memory.max", async () => {
  const reading = await readMemory(
    reader(container({ high: bytes(5 * GIB), max: bytes(6 * GIB) })),
  );
  expect(reading).toMatchObject({ cgroup: { limitBytes: 5 * GIB } });
});

it("ignores a literal max and sees no container limit when both are max", async () => {
  const reading = await readMemory(reader(container({ max: "max\n", high: "max" })));
  expect(reading).toMatchObject({ supported: true, cgroup: null });
});

it("falls back to the machine pressure when the cgroup has no pressure file", async () => {
  const reading = await readMemory(reader(container({ pressure: undefined })));
  expect(reading).toMatchObject({ pressureFullAvg10: 14.25 });
});

it("reads a machine without a container limit from MemAvailable", async () => {
  const reading = await readMemory(reader(machine));
  expect(reading).toEqual({
    supported: true,
    cgroup: null,
    machineAvailableBytes: 3145728 * 1024,
    pressureFullAvg10: 14.25,
  });
});

it("gives a reading with no figures where nothing can be read, rather than unsupported", async () => {
  const empty = {
    supported: true,
    cgroup: null,
    machineAvailableBytes: null,
    pressureFullAvg10: null,
  };
  expect(await readMemory(reader({}))).toEqual(empty);
  expect(await readMemory(reader({ [MEMORY_FILES.machinePressure]: PRESSURE_BUSY }))).toEqual({
    ...empty,
    pressureFullAvg10: 14.25,
  });
});

it("makes only the field of a garbage file null", async () => {
  const reading = await readMemory(
    reader({
      ...container({ pressure: "full avg10=abc avg60=0.00\n" }),
      [MEMORY_FILES.meminfo]: "MemAvailable: lots\n",
      [MEMORY_FILES.machinePressure]: "garbage",
    }),
  );
  expect(reading).toEqual({
    supported: true,
    cgroup: { limitBytes: 6 * GIB, workingSetBytes: 3 * GIB },
    machineAvailableBytes: null,
    pressureFullAvg10: null,
  });
});

it("drops the container reading when memory.current is garbage, and a garbage limit", async () => {
  expect(await readMemory(reader(container({ current: "12x" })))).toMatchObject({
    cgroup: null,
  });
  expect(await readMemory(reader(container({ max: "-5", high: "max" })))).toMatchObject({
    cgroup: null,
  });
});

it("counts the whole of memory.current when memory.stat cannot be read", async () => {
  const reading = await readMemory(reader(container({ stat: "inactive_file" })));
  expect(reading).toMatchObject({ cgroup: { workingSetBytes: 4 * GIB } });
});

it("does not trust truncated content", async () => {
  const reading = await readMemory(
    reader({
      ...container({ max: "", high: "" }),
      [MEMORY_FILES.meminfo]: "MemTotal:       12582912 kB\nMemAvail",
      [MEMORY_FILES.machinePressure]:
        "some avg10=31.50 avg60=12.04 avg300=3.10 total=99887766\nfull avg",
    }),
  );
  expect(reading).toMatchObject({ cgroup: null, machineAvailableBytes: null });
});

it("ignores a memory.stat line cut off mid-number", async () => {
  const reading = await readMemory(
    reader(container({ stat: "anon 1836490752\ninactive_file 10737" })),
  );
  expect(reading).toMatchObject({ cgroup: { workingSetBytes: 4 * GIB } });
});

it("never reports a negative working set", async () => {
  const reading = await readMemory(
    reader(container({ current: "1000\n", stat: "inactive_file 5000\n" })),
  );
  expect(reading).toMatchObject({ cgroup: { workingSetBytes: 0 } });
});

it("counts reclaimable file cache out even when memory.current is above memory.high", async () => {
  const reading = await readMemory(
    reader(
      container({
        max: "max\n",
        high: bytes(4096 * MIB),
        current: bytes(4200 * MIB),
        stat: `inactive_file ${String(800 * MIB)}\n`,
      }),
    ),
  );
  expect(reading.supported && reading.cgroup).toEqual({
    limitBytes: 4096 * MIB,
    workingSetBytes: 3400 * MIB,
  });
  expect(freeBytes(reading)).toBe(696 * MIB);
});

it("finds the container budget on an ancestor when the process sits in a child group without one", async () => {
  const reading = await readMemory(
    reader({
      ...machine,
      [MEMORY_FILES.meminfo]: "MemAvailable: 7000000 kB\n",
      ...placed("/tenant/agent"),
      ...group(MOUNT, { max: "max\n", high: "max\n", current: bytes(4200 * MIB) }),
      ...group(`${MOUNT}/tenant`, {
        high: bytes(4096 * MIB),
        max: bytes(4608 * MIB),
        current: bytes(4000 * MIB),
        stat: "inactive_file 0\n",
      }),
      ...group(`${MOUNT}/tenant/agent`, {
        high: "max\n",
        max: "max\n",
        current: bytes(1800 * MIB),
      }),
    }),
  );
  expect(reading).toMatchObject({
    cgroup: { limitBytes: 4096 * MIB, workingSetBytes: 4000 * MIB },
  });
  expect(freeBytes(reading)).toBe(96 * MIB);
});

it("keeps an ancestor's limit when the process's own group has no memory files", async () => {
  const read = (own: Files) =>
    readMemory(
      reader({
        ...machine,
        [MEMORY_FILES.meminfo]: "MemAvailable: 8000000 kB\n",
        ...placed("/tenant/agent"),
        ...group(`${MOUNT}/tenant`, {
          max: bytes(1024 * MIB),
          current: bytes(928 * MIB),
          stat: "inactive_file 0\n",
          pressure: PRESSURE_SOME,
        }),
        ...own,
      }),
    );
  const undelegated = await read({});
  expect(undelegated).toMatchObject({
    cgroup: { limitBytes: 1024 * MIB, workingSetBytes: 928 * MIB },
    pressureFullAvg10: 3.5,
  });
  expect(freeBytes(undelegated)).toBe(96 * MIB);
  expect(await read(group(`${MOUNT}/tenant/agent`, { pressure: PRESSURE_CALM }))).toMatchObject({
    cgroup: { limitBytes: 1024 * MIB },
    pressureFullAvg10: 3.5,
  });
});

it("reads the mount point when the process sits at the root of its cgroup namespace", async () => {
  const reading = await readMemory(reader({ ...container(), ...placed("/") }));
  expect(reading).toMatchObject({
    cgroup: { limitBytes: 6 * GIB, workingSetBytes: 4 * GIB - 1073741824 },
  });
});

it("binds to whichever level has the least room, the child or its parent", async () => {
  const levels = (child: [number, number], parent: [number, number]) =>
    reader({
      ...machine,
      ...placed("/team/agent"),
      ...group(`${MOUNT}/team`, { max: bytes(parent[0]), current: bytes(parent[1]) }),
      ...group(`${MOUNT}/team/agent`, { max: bytes(child[0]), current: bytes(child[1]) }),
    });
  expect(await readMemory(levels([1 * GIB, GIB / 2], [4 * GIB, 2 * GIB]))).toMatchObject({
    cgroup: { limitBytes: 1 * GIB, workingSetBytes: GIB / 2 },
  });
  expect(await readMemory(levels([2 * GIB, GIB / 2], [4 * GIB, 3.5 * GIB]))).toMatchObject({
    cgroup: { limitBytes: 4 * GIB, workingSetBytes: 3.5 * GIB },
  });
});

it("maps the process's path under a mount root other than / onto the mount point", async () => {
  const reading = await readMemory(
    reader({
      ...machine,
      ...placed("/docker/x/agent", "/docker/x"),
      ...group(`${MOUNT}/agent`, { max: bytes(2 * GIB), current: bytes(1 * GIB) }),
      ...group(`${MOUNT}/docker/x/agent`, { max: bytes(8 * GIB), current: bytes(1 * GIB) }),
    }),
  );
  expect(reading).toMatchObject({ cgroup: { limitBytes: 2 * GIB, workingSetBytes: 1 * GIB } });
});

it("reads the pressure of the binding level, else of the process's own group, else the machine", async () => {
  const files = (tenant: string | undefined, agent: string | undefined) =>
    reader({
      ...machine,
      ...placed("/tenant/agent"),
      ...group(`${MOUNT}/tenant`, {
        max: bytes(4 * GIB),
        current: bytes(1 * GIB),
        pressure: tenant,
      }),
      ...group(`${MOUNT}/tenant/agent`, { max: "max\n", current: bytes(GIB / 2), pressure: agent }),
    });
  expect(await readMemory(files(PRESSURE_SOME, PRESSURE_CALM))).toMatchObject({
    pressureFullAvg10: 3.5,
  });
  expect(await readMemory(files(undefined, PRESSURE_SOME))).toMatchObject({
    pressureFullAvg10: 3.5,
  });
  expect(await readMemory(files(undefined, undefined))).toMatchObject({
    pressureFullAvg10: 14.25,
  });
});

it("reads the mount root alone when the process's group cannot be found or read", async () => {
  const tenant = {
    ...group(`${MOUNT}/tenant`, { max: bytes(2 * GIB), current: bytes(1 * GIB) }),
    ...group(`${MOUNT}/tenant/agent`, { max: "max\n", current: bytes(GIB / 2) }),
  };
  const rootOnly = { cgroup: { limitBytes: 6 * GIB, workingSetBytes: 4 * GIB - 1073741824 } };
  const padded = `${"24 22 0:5 / /dev rw - devtmpfs udev rw\n".repeat(4000)}${mountLine("/", MOUNT)}`;
  expect(padded.length).toBeGreaterThan(64 * 1024);
  expect(
    await readMemory(
      reader({ ...container(), ...tenant, ...placed("/tenant/agent", "/", padded) }),
    ),
  ).toMatchObject({ cgroup: { limitBytes: 2 * GIB } });
  const huge = `${"x".repeat(2 ** 20)}\n${mountLine("/", MOUNT)}`;
  for (const files of [
    placed("/tenant/agent", "/", huge),
    placed("/tenant/agent", "/", OTHER_MOUNTS),
    { "/proc/self/mountinfo": mountLine("/", MOUNT) },
    placed("/tenant/agent", "/docker/x"),
    placed("/elsewhere"),
  ])
    expect(await readMemory(reader({ ...container(), ...tenant, ...files }))).toMatchObject(
      rootOnly,
    );
});

it("interprets the figures of a real cgroup root", async () => {
  const reading = await readMemory(
    reader({
      ...placed("/"),
      ...group(MOUNT, {
        high: "4294967296\n",
        max: "4831838208\n",
        current: "3929219072\n",
        stat: "anon 3300000000\nfile 500000000\ninactive_file 163319808\n",
        pressure: PRESSURE_CALM,
      }),
      [MEMORY_FILES.meminfo]: "MemTotal:       12582912 kB\nMemAvailable:    7462448 kB\n",
    }),
  );
  expect(reading).toEqual({
    supported: true,
    cgroup: { limitBytes: 4294967296, workingSetBytes: 3765899264 },
    machineAvailableBytes: 7462448 * 1024,
    pressureFullAvg10: 0,
  });
  expect(freeBytes(reading)).toBe(529068032);
});
