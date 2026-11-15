import { describeError } from "./executors/paging.js";

export type PassStep = readonly [name: string, run: () => unknown];

export async function runSteps(
  steps: readonly PassStep[],
  warn: (message: string) => void,
): Promise<void> {
  for (const [name, run] of steps) {
    try {
      await run();
    } catch (error) {
      warn(`${name} failed: ${describeError(error)}`);
    }
  }
}
