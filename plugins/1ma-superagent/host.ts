import { execFile } from "node:child_process";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { GH_OUTPUT_LIMIT, hostContract } from "./src/host-contract.js";

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

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    ghApi: async ({ path }, context) => ghApi(path, context.signal),
  },
});
