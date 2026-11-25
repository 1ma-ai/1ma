import type { Executor, ServerId } from "./observation.js";
import type { RepoPolicy } from "./repos.js";

export interface Admission {
  readonly generation: number;
  readonly active: boolean;
}

export interface PluginSettings extends Admission {
  readonly policy: RepoPolicy;
  readonly executors: ReadonlyMap<ServerId, Executor>;
}

export type Guard = () => boolean;

export function admitted(read: Admission, current: Admission): boolean {
  return current.active && current.generation === read.generation;
}

export function guardOf(read: Admission, current: () => Admission): Guard {
  return () => admitted(read, current());
}
