import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createRetryTimer } from "./retry.js";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function setup() {
  const fired: number[] = [];
  const started = performance.now();
  const timer = createRetryTimer(
    () => performance.now(),
    () => fired.push(Math.round(performance.now() - started)),
  );
  return { fired, timer };
}

it("fires at the booked time", async () => {
  const { fired, timer } = setup();
  timer.book(2_000);
  await vi.advanceTimersByTimeAsync(1_999);
  expect(fired).toEqual([]);
  await vi.advanceTimersByTimeAsync(1);
  expect(fired).toEqual([2_000]);
  timer.dispose();
});

// Core passes over a turn it queued again less than a second ago, so the
// earlier firing does not stand in for a time booked just before it.
it("fires again at a later time booked before the earlier one fired", async () => {
  const { fired, timer } = setup();
  timer.book(2_000);
  await vi.advanceTimersByTimeAsync(1_500);
  timer.book(15_000);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(fired).toEqual([2_000, 16_500]);
  timer.dispose();
});

it("fires at the earliest and at the latest of many booked times, not once per booking", async () => {
  const { fired, timer } = setup();
  for (let i = 0; i < 5; i++) {
    timer.book(15_000);
    await vi.advanceTimersByTimeAsync(1_000);
  }
  await vi.advanceTimersByTimeAsync(60_000);
  expect(fired).toEqual([15_000, 19_000]);
  timer.dispose();
});

it("moves to an earlier time booked later and still fires at the later one", async () => {
  const { fired, timer } = setup();
  timer.book(15_000);
  timer.book(2_000);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(fired).toEqual([2_000, 15_000]);
  timer.dispose();
});

it("fires once for bookings of the same time", async () => {
  const { fired, timer } = setup();
  timer.book(15_000);
  timer.book(15_000);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(fired).toEqual([15_000]);
  timer.dispose();
});

it("fires nothing and holds no timer after dispose", async () => {
  const { fired, timer } = setup();
  timer.book(2_000);
  timer.book(15_000);
  timer.dispose();
  expect(vi.getTimerCount()).toBe(0);
  timer.book(2_000);
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(fired).toEqual([]);
});

it("holds no timer once the latest booked time has fired", async () => {
  const { timer } = setup();
  timer.book(2_000);
  timer.book(15_000);
  await vi.advanceTimersByTimeAsync(15_000);
  expect(vi.getTimerCount()).toBe(0);
  timer.dispose();
});
