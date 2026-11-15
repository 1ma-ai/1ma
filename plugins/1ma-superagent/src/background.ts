import { AsyncResource } from "node:async_hooks";

export interface Background {
  run<T>(work: () => T): T;
}

export function createBackground(): Background {
  const resource = new AsyncResource("1ma-superagent-background");
  return { run: (work) => resource.runInAsyncScope(work) };
}

export const inPlace: Background = { run: (work) => work() };
