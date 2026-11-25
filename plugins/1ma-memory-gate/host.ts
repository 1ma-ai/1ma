import { open } from "node:fs/promises";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { memoryHostContract, type MemoryReading } from "./contract.js";
import { readMemory, type ReadFile } from "./memory.js";

export const MAX_FILE_BYTES = 64 * 1024;

export const readKernelFile: ReadFile = async (path, maxBytes = MAX_FILE_BYTES) => {
  try {
    const file = await open(path, "r");
    try {
      const buffer = Buffer.alloc(maxBytes + 1);
      let length = 0;
      for (;;) {
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
        if (bytesRead === 0) return buffer.toString("utf8", 0, length);
        length += bytesRead;
        if (length > maxBytes) return null;
      }
    } finally {
      await file.close();
    }
  } catch {
    return null;
  }
};

export function createHostEntry(read: ReadFile, platform: NodeJS.Platform) {
  return experimental_defineHostEntry({
    contract: memoryHostContract,
    handlers: {
      readMemory: async (): Promise<MemoryReading> =>
        platform === "linux" ? readMemory(read) : { supported: false },
    },
  });
}

export default createHostEntry(readKernelFile, process.platform);
