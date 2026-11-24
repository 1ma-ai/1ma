import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { afterEach, expect, it } from "vitest";
import { createHostEntry, MAX_FILE_BYTES, readKernelFile } from "./host.js";
import { MEMORY_FILES } from "./memory.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

it("answers readMemory through the daemon's validation boundary", async () => {
  const contents = new Map<string, string>([
    [MEMORY_FILES.cgroupMax, "1073741824\n"],
    [MEMORY_FILES.cgroupHigh, "max\n"],
    [MEMORY_FILES.cgroupCurrent, "536870912\n"],
    [MEMORY_FILES.cgroupStat, "inactive_file 134217728\n"],
  ]);
  const harness = experimental_createHostEntryHarness(
    createHostEntry(async (path) => contents.get(path) ?? null),
  );
  try {
    expect(await harness.experimental_call("readMemory", null)).toEqual({
      supported: true,
      cgroup: { limitBytes: 1073741824, workingSetBytes: 402653184 },
      machineAvailableBytes: null,
      pressureFullAvg10: null,
    });
  } finally {
    await harness.experimental_dispose();
  }
});

it("answers unsupported on a machine without the kernel files", async () => {
  const harness = experimental_createHostEntryHarness(createHostEntry(async () => null));
  try {
    expect(await harness.experimental_call("readMemory", null)).toEqual({ supported: false });
  } finally {
    await harness.experimental_dispose();
  }
});

it("reads a small file, and refuses a missing or oversized one instead of throwing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "memory-gate-"));
  dirs.push(dir);
  await writeFile(join(dir, "small"), "max\n");
  await writeFile(join(dir, "large"), "x".repeat(MAX_FILE_BYTES + 1));
  expect(await readKernelFile(join(dir, "small"))).toBe("max\n");
  expect(await readKernelFile(join(dir, "large"))).toBeNull();
  expect(await readKernelFile(join(dir, "missing"))).toBeNull();
});
