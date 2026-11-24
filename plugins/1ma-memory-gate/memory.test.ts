import { expect, it } from "vitest";
import { memoryReadingSchema } from "./contract.js";
import { MEMORY_FILES, readMemory } from "./memory.js";

const GIB = 2 ** 30;

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

const MEMINFO = `MemTotal:       12582912 kB
MemFree:          524288 kB
MemAvailable:    3145728 kB
Buffers:          102400 kB
Cached:          2097152 kB
`;

function files(contents: Partial<Record<keyof typeof MEMORY_FILES, string>>) {
  const byPath = new Map<string, string | undefined>(
    Object.entries(contents).map(([key, text]) => [
      MEMORY_FILES[key as keyof typeof MEMORY_FILES],
      text,
    ]),
  );
  return async (path: string) => byPath.get(path) ?? null;
}

const container = {
  cgroupMax: `${String(6 * GIB)}\n`,
  cgroupHigh: "max\n",
  cgroupCurrent: `${String(4 * GIB)}\n`,
  cgroupStat: MEMORY_STAT,
  cgroupPressure: PRESSURE_CALM,
  meminfo: MEMINFO,
  machinePressure: PRESSURE_BUSY,
};

it("reads the container limit, its working set without reclaimable file cache, the machine and the pressure", async () => {
  const reading = await readMemory(files(container));
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
    files({ ...container, cgroupHigh: `${String(5 * GIB)}\n`, cgroupMax: `${String(6 * GIB)}\n` }),
  );
  expect(reading).toMatchObject({ cgroup: { limitBytes: 5 * GIB } });
});

it("ignores a literal max and sees no container limit when both are max", async () => {
  const reading = await readMemory(files({ ...container, cgroupMax: "max\n", cgroupHigh: "max" }));
  expect(reading).toMatchObject({ supported: true, cgroup: null });
});

it("falls back to the machine pressure when the cgroup has no pressure file", async () => {
  const reading = await readMemory(files({ ...container, cgroupPressure: undefined }));
  expect(reading).toMatchObject({ pressureFullAvg10: 14.25 });
});

it("reads a machine without a container limit from MemAvailable", async () => {
  const reading = await readMemory(files({ meminfo: MEMINFO, machinePressure: PRESSURE_BUSY }));
  expect(reading).toEqual({
    supported: true,
    cgroup: null,
    machineAvailableBytes: 3145728 * 1024,
    pressureFullAvg10: 14.25,
  });
});

it("says unsupported where neither a container limit nor MemAvailable can be read", async () => {
  expect(await readMemory(files({}))).toEqual({ supported: false });
  expect(await readMemory(files({ machinePressure: PRESSURE_BUSY }))).toEqual({
    supported: false,
  });
});

it("makes only the field of a garbage file null", async () => {
  const reading = await readMemory(
    files({
      ...container,
      meminfo: "MemAvailable: lots\n",
      cgroupPressure: "full avg10=abc avg60=0.00\n",
      machinePressure: "garbage",
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
  expect(await readMemory(files({ ...container, cgroupCurrent: "12x" }))).toMatchObject({
    cgroup: null,
  });
  expect(
    await readMemory(files({ ...container, cgroupMax: "-5", cgroupHigh: "max" })),
  ).toMatchObject({ cgroup: null });
});

it("counts the whole of memory.current when memory.stat cannot be read", async () => {
  const reading = await readMemory(files({ ...container, cgroupStat: "inactive_file" }));
  expect(reading).toMatchObject({ cgroup: { workingSetBytes: 4 * GIB } });
});

it("does not trust truncated content", async () => {
  const reading = await readMemory(
    files({
      ...container,
      cgroupMax: "",
      cgroupHigh: "",
      meminfo: "MemTotal:       12582912 kB\nMemAvail",
      machinePressure: "some avg10=31.50 avg60=12.04 avg300=3.10 total=99887766\nfull avg",
    }),
  );
  expect(reading).toEqual({ supported: false });
});

it("ignores a memory.stat line cut off mid-number", async () => {
  const reading = await readMemory(
    files({ ...container, cgroupStat: "anon 1836490752\ninactive_file 10737" }),
  );
  expect(reading).toMatchObject({ cgroup: { workingSetBytes: 4 * GIB } });
});

it("never reports a negative working set", async () => {
  const reading = await readMemory(
    files({ ...container, cgroupCurrent: "1000\n", cgroupStat: "inactive_file 5000\n" }),
  );
  expect(reading).toMatchObject({ cgroup: { workingSetBytes: 0 } });
});
