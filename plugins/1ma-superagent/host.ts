import { execFile } from "node:child_process";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { GH_OUTPUT_LIMIT, type GhRequest, ghArgs, hostContract } from "./src/host-contract.js";
import { readTrainJournal } from "./src/host-journal.js";

const GH_TIMEOUT_MS = 20_000;

function gh(
  request: GhRequest,
  signal: AbortSignal,
): Promise<{ status: "ok"; body: string } | { status: "error"; message: string }> {
  return new Promise((resolve) => {
    execFile(
      "gh",
      ghArgs(request),
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

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    gh: async (request, context) => gh(request, context.signal),
    readJournal: async (_input, context) => readTrainJournal(context.experimental_paths.dataDir),
  },
});
