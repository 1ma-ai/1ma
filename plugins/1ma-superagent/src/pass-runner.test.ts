import { describe, expect, it } from "vitest";
import { FULL_SCOPE, PassRunner, type PassScope, mergeScopes, threadScope } from "./pass-runner.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("mergeScopes", () => {
  it("keeps every thread of both scopes", () => {
    const merged = mergeScopes(threadScope("mac", "thr_a"), threadScope("linux", "thr_b"));
    expect(merged.full).toBe(false);
    expect([...merged.threadKeys].toSorted()).toEqual(["linux:thr_b", "mac:thr_a"]);
  });

  it("widens to a full pass when either side is full", () => {
    expect(mergeScopes(threadScope("mac", "thr_a"), FULL_SCOPE).full).toBe(true);
  });
});

describe("PassRunner", () => {
  it("runs one pass at a time and folds requests made during a pass into one next pass", async () => {
    const seen: PassScope[] = [];
    const gate = deferred();
    let active = 0;
    let maxActive = 0;
    const runner = new PassRunner(
      async (scope) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        seen.push(scope);
        if (seen.length === 1) await gate.promise;
        active -= 1;
      },
      () => {},
    );
    const first = runner.request(threadScope("mac", "thr_1"));
    const second = runner.request(threadScope("mac", "thr_2"));
    const third = runner.request(threadScope("linux", "thr_3"));
    gate.resolve();
    await Promise.all([first, second, third]);
    expect(maxActive).toBe(1);
    expect(seen).toHaveLength(2);
    expect([...(seen[1]?.threadKeys ?? [])].toSorted()).toEqual(["linux:thr_3", "mac:thr_2"]);
  });

  it("keeps running after a failed pass", async () => {
    const errors: unknown[] = [];
    let calls = 0;
    const runner = new PassRunner(
      async () => {
        calls += 1;
        if (calls === 1) throw new Error("boom");
      },
      (error) => errors.push(error),
    );
    await runner.request(FULL_SCOPE);
    await runner.request(FULL_SCOPE);
    expect(calls).toBe(2);
    expect(errors).toHaveLength(1);
  });

  it("resolves waiting requests and runs nothing after dispose", async () => {
    let calls = 0;
    const gate = deferred();
    const runner = new PassRunner(
      async () => {
        calls += 1;
        await gate.promise;
      },
      () => {},
    );
    const first = runner.request(FULL_SCOPE);
    const pending = runner.request(FULL_SCOPE);
    void runner.dispose();
    await pending;
    gate.resolve();
    await first;
    await runner.request(FULL_SCOPE);
    expect(calls).toBe(1);
  });

  it("finishes the running pass before dispose resolves", async () => {
    const gate = deferred();
    const finished: string[] = [];
    const runner = new PassRunner(
      async () => {
        await gate.promise;
        finished.push("pass wrote its result");
      },
      () => {},
    );
    void runner.request(FULL_SCOPE);
    let disposed = false;
    const disposal = runner.dispose().then(() => {
      disposed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(disposed).toBe(false);
    gate.resolve();
    await disposal;
    expect(finished).toEqual(["pass wrote its result"]);
  });
});
