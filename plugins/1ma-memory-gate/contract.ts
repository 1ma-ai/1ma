import type { PluginRpcMethodContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

const bytes = z.number().int().nonnegative();

export const memoryReadingSchema = z.discriminatedUnion("supported", [
  z.object({ supported: z.literal(false) }).strict(),
  z
    .object({
      supported: z.literal(true),
      cgroup: z.object({ limitBytes: bytes, workingSetBytes: bytes }).strict().nullable(),
      machineAvailableBytes: bytes.nullable(),
      pressureFullAvg10: z.number().min(0).max(100).nullable(),
    })
    .strict(),
]);

export type MemoryReading = z.infer<typeof memoryReadingSchema>;

export const memoryHostContract = {
  readMemory: { input: z.null(), output: memoryReadingSchema },
} satisfies Record<string, PluginRpcMethodContract>;
