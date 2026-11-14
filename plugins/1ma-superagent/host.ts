import { execFile } from "node:child_process";
import { open } from "node:fs/promises";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { GH_OUTPUT_LIMIT, JOURNAL_TAIL_BYTES, hostContract } from "./src/host-contract.js";

const GH_TIMEOUT_MS = 20_000;

function ghApi(
  path: string,
  signal: AbortSignal,
): Promise<{ status: "ok"; body: string } | { status: "error"; message: string }> {
  return new Promise((resolve) => {
    execFile(
      "gh",
      ["api", "--method", "GET", "-H", "Accept: application/vnd.github+json", path],
      {
        signal,
        timeout: GH_TIMEOUT_MS,
        maxBuffer: GH_OUTPUT_LIMIT,
        env: { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" },
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = `${stderr}`.trim().split("\n").slice(-3).join(" ").slice(0, 400);
          resolve({ status: "error", message: `${error.message.split("\n")[0]} ${detail}`.trim() });
          return;
        }
        resolve({ status: "ok", body: stdout });
      },
    );
  });
}

async function readJournalTail(
  path: string,
): Promise<
  { status: "ok"; text: string; truncated: boolean } | { status: "error"; message: string }
> {
  try {
    const file = await open(path, "r");
    try {
      const { size } = await file.stat();
      const start = Math.max(0, size - JOURNAL_TAIL_BYTES);
      const buffer = Buffer.alloc(size - start);
      await file.read(buffer, 0, buffer.length, start);
      const text = buffer.toString("utf8");
      return {
        status: "ok",
        text: start === 0 ? text : text.slice(text.indexOf("\n") + 1),
        truncated: start > 0,
      };
    } finally {
      await file.close();
    }
  } catch (error) {
    return { status: "error", message: error instanceof Error ? error.message : String(error) };
  }
}

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    ghApi: async ({ path }, context) => ghApi(path, context.signal),
    readJournal: async ({ path }) => readJournalTail(path),
  },
});
