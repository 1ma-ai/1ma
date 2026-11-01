import { describe, expect, it } from "vitest";
import { isoTime, page, relativeTime, tasksView } from "./view";

const ready = { isLoading: false, error: null, doneIds: ["thr_done"] };

describe("tasksView", () => {
  it("keeps bb's lanes when Focus Board is off or answers something else", () => {
    const off = tasksView({
      threadsStatus: "ready",
      done: {
        isLoading: false,
        error: new Error("plugin focus-board is disabled"),
        doneIds: undefined,
      },
    });
    expect(off).toEqual({ kind: "ready", doneIds: new Set(), focusBoardMissing: true });
    const odd = tasksView({
      threadsStatus: "ready",
      done: { isLoading: false, error: null, doneIds: undefined },
    });
    expect(odd).toMatchObject({ kind: "ready", focusBoardMissing: true });
  });

  it("marks Focus Board's done threads when it answers", () => {
    expect(tasksView({ threadsStatus: "ready", done: ready })).toEqual({
      kind: "ready",
      doneIds: new Set(["thr_done"]),
      focusBoardMissing: false,
    });
  });

  it("waits for both sources and reports a failure of bb's own threads", () => {
    expect(tasksView({ threadsStatus: "loading", done: ready })).toEqual({ kind: "loading" });
    expect(tasksView({ threadsStatus: "ready", done: { ...ready, isLoading: true } })).toEqual({
      kind: "loading",
    });
    expect(tasksView({ threadsStatus: "error", done: ready })).toEqual({ kind: "error" });
  });
});

describe("page", () => {
  it("renders a long lane in pages and counts the rest", () => {
    const threads = Array.from({ length: 120 }, (_, index) => index);
    expect(page(threads, 50)).toEqual({ items: threads.slice(0, 50), hidden: 70 });
    expect(page(threads, 150)).toEqual({ items: threads, hidden: 0 });
  });
});

describe("times", () => {
  it("does not throw on a broken timestamp", () => {
    expect(isoTime(Number.NaN)).toBeUndefined();
    expect(isoTime(8.64e16)).toBeUndefined();
    expect(isoTime(0)).toBe("1970-01-01T00:00:00.000Z");
    expect(relativeTime(Number.NaN, 1_000)).toBe("");
  });

  it("says how long ago a thread was active", () => {
    const now = 10 * 24 * 3_600_000;
    expect(relativeTime(now - 30_000, now)).toBe("just now");
    expect(relativeTime(now - 5 * 60_000, now)).toBe("5m ago");
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe("3h ago");
    expect(relativeTime(now - 2 * 24 * 3_600_000, now)).toBe("2d ago");
  });
});
