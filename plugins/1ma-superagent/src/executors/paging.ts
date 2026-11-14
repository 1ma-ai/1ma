import type { Completeness } from "../observation.js";

export interface PagingLimits {
  readonly pageSize: number;
  readonly maxPages: number;
  readonly pageTimeoutMs: number;
  readonly totalTimeoutMs: number;
}

export const DEFAULT_LIMITS: PagingLimits = {
  pageSize: 200,
  maxPages: 25,
  pageTimeoutMs: 10_000,
  totalTimeoutMs: 30_000,
};

export interface Collected<T> {
  readonly items: T[];
  readonly completeness: Completeness;
  readonly error?: string;
}

export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause instanceof Error ? `: ${error.cause.message}` : "";
    return `${error.message}${cause}`.slice(0, 500);
  }
  return String(error).slice(0, 500);
}

export async function collectPages<T>(
  fetchPage: (offset: number, limit: number, signal: AbortSignal) => Promise<T[]>,
  limits: PagingLimits,
  signal: AbortSignal,
): Promise<Collected<T>> {
  const total = AbortSignal.any([signal, AbortSignal.timeout(limits.totalTimeoutMs)]);
  const items: T[] = [];
  const fetchFrom = async (page: number): Promise<Collected<T>> => {
    if (page >= limits.maxPages) {
      return { items, completeness: "partial", error: `stopped after ${limits.maxPages} pages` };
    }
    let rows: T[];
    try {
      const pageSignal = AbortSignal.any([total, AbortSignal.timeout(limits.pageTimeoutMs)]);
      rows = await fetchPage(page * limits.pageSize, limits.pageSize, pageSignal);
    } catch (error) {
      return {
        items,
        completeness: page === 0 ? "failed" : "partial",
        error: describeError(error),
      };
    }
    items.push(...rows);
    if (rows.length < limits.pageSize) return { items, completeness: "complete" };
    return fetchFrom(page + 1);
  };
  return fetchFrom(0);
}

export function worst(...values: Completeness[]): Completeness {
  if (values.includes("failed")) return "failed";
  if (values.includes("partial")) return "partial";
  return "complete";
}

export async function collectOnce<T>(
  fetchAll: (signal: AbortSignal) => Promise<T[]>,
  limits: PagingLimits,
  signal: AbortSignal,
): Promise<Collected<T>> {
  try {
    const items = await fetchAll(
      AbortSignal.any([signal, AbortSignal.timeout(limits.pageTimeoutMs)]),
    );
    return { items, completeness: "complete" };
  } catch (error) {
    return { items: [], completeness: "failed", error: describeError(error) };
  }
}
