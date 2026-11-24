import { open } from "node:fs/promises";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { memoryHostContract } from "./contract.js";
import { readMemory, type ReadFile } from "./memory.js";

export const MAX_FILE_BYTES = 64 * 1024;

export const readKernelFile: ReadFile = async (path) => {
  try {
    const file = await open(path, "r");
    try {
      const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      return bytesRead > MAX_FILE_BYTES ? null : buffer.toString("utf8", 0, bytesRead);
    } finally {
      await file.close();
    }
  } catch {
    return null;
  }
};

export function createHostEntry(read: ReadFile) {
  return experimental_defineHostEntry({
    contract: memoryHostContract,
    handlers: {
      readMemory: () => readMemory(read),
    },
  });
}

export default createHostEntry(readKernelFile);
