import { describe, expect, it } from "vitest";
import { runSteps } from "./pass-steps.js";

describe("the steps after a full pass", () => {
  it("still show the stored questions when reading the journal throws", async () => {
    const done: string[] = [];
    const warnings: string[] = [];
    await runSteps(
      [
        ["bot actions", () => done.push("actions")],
        [
          "check of main",
          async () => {
            throw new Error("host RPC rejected");
          },
        ],
        ["task results", () => done.push("reports")],
        ["questions", () => done.push("dispatch")],
      ],
      (message) => warnings.push(message),
      () => true,
    );
    expect(done).toEqual(["actions", "reports", "dispatch"]);
    expect(warnings).toEqual(["check of main failed: host RPC rejected"]);
  });

  it("run no further step once the settings changed under the pass", async () => {
    const done: string[] = [];
    let admitted = true;
    await runSteps(
      [
        [
          "bot actions",
          () => {
            done.push("actions");
            admitted = false;
          },
        ],
        ["questions", () => done.push("dispatch")],
      ],
      () => {},
      () => admitted,
    );
    expect(done).toEqual(["actions"]);
  });
});
