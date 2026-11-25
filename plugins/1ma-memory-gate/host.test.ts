import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { afterEach, expect, it } from "vitest";
import { createHostEntry, MAX_FILE_BYTES, readKernelFile } from "./host.js";
import { MAX_MOUNTINFO_BYTES } from "./memory.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const containerFiles = new Map<string, string>([
  ["/sys/fs/cgroup/memory.max", "1073741824\n"],
  ["/sys/fs/cgroup/memory.high", "max\n"],
  ["/sys/fs/cgroup/memory.current", "536870912\n"],
  ["/sys/fs/cgroup/memory.stat", "inactive_file 134217728\n"],
]);

it("answers readMemory through the daemon's validation boundary", async () => {
  const harness = experimental_createHostEntryHarness(
    createHostEntry(async (path) => containerFiles.get(path) ?? null, "linux"),
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

it("answers a reading without figures on Linux when no kernel file can be read", async () => {
  const harness = experimental_createHostEntryHarness(createHostEntry(async () => null, "linux"));
  try {
    expect(await harness.experimental_call("readMemory", null)).toEqual({
      supported: true,
      cgroup: null,
      machineAvailableBytes: null,
      pressureFullAvg10: null,
    });
  } finally {
    await harness.experimental_dispose();
  }
});

it("answers unsupported on a machine that is not Linux", async () => {
  const harness = experimental_createHostEntryHarness(
    createHostEntry(async (path) => containerFiles.get(path) ?? null, "darwin"),
  );
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

it("reads a file up to the bound the caller gives", async () => {
  const dir = await mkdtemp(join(tmpdir(), "memory-gate-"));
  dirs.push(dir);
  const text = "x".repeat(MAX_FILE_BYTES * 4);
  await writeFile(join(dir, "mountinfo"), text);
  await writeFile(join(dir, "huge"), "x".repeat(MAX_MOUNTINFO_BYTES + 1));
  expect(await readKernelFile(join(dir, "mountinfo"), MAX_MOUNTINFO_BYTES)).toBe(text);
  expect(await readKernelFile(join(dir, "huge"), MAX_MOUNTINFO_BYTES)).toBeNull();
});
