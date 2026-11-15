import { describe, expect, it } from "vitest";
import { type PagingLimits, collectPages, worst } from "./paging.js";

const limits: PagingLimits = { pageSize: 2, maxPages: 3, pageTimeoutMs: 50, totalTimeoutMs: 1_000 };
const signal = new AbortController().signal;

function pages(...rows: number[][]) {
  return async (offset: number) => {
    const page = rows[offset / limits.pageSize];
    if (page === undefined) throw new Error(`no page at ${offset}`);
    return page;
  };
}

describe("collectPages", () => {
  it("is complete when the last page is short", async () => {
    expect(await collectPages(pages([1, 2], [3]), limits, signal)).toEqual({
      items: [1, 2, 3],
      completeness: "complete",
    });
  });

  it("fails when the first page fails, so an empty list is never taken for no chats", async () => {
    const result = await collectPages(pages(), limits, signal);
    expect(result).toMatchObject({ items: [], completeness: "failed" });
  });

  it("is partial when a later page fails", async () => {
    const result = await collectPages(pages([1, 2]), limits, signal);
    expect(result).toMatchObject({ items: [1, 2], completeness: "partial" });
  });

  it("is partial when it stops at the page limit", async () => {
    const result = await collectPages(pages([1, 2], [3, 4], [5, 6], [7]), limits, signal);
    expect(result).toMatchObject({ items: [1, 2, 3, 4, 5, 6], completeness: "partial" });
  });

  it("gives up on a page that does not answer in time", async () => {
    const result = await collectPages(
      (_offset, _limit, pageSignal) =>
        new Promise<number[]>((_resolve, reject) => {
          pageSignal.addEventListener("abort", () => reject(pageSignal.reason), { once: true });
        }),
      limits,
      signal,
    );
    expect(result.completeness).toBe("failed");
  });
});

describe("worst", () => {
  it("orders failed over partial over complete", () => {
    expect(worst("complete", "partial")).toBe("partial");
    expect(worst("partial", "failed", "complete")).toBe("failed");
    expect(worst("complete", "complete")).toBe("complete");
  });
});
