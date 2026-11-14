export interface PassScope {
  readonly full: boolean;
  readonly threadKeys: ReadonlySet<string>;
}

export const FULL_SCOPE: PassScope = { full: true, threadKeys: new Set() };

export function threadScope(serverId: string, threadId: string): PassScope {
  return { full: false, threadKeys: new Set([threadKey(serverId, threadId)]) };
}

export function threadKey(serverId: string, threadId: string): string {
  return `${serverId}:${threadId}`;
}

export function mergeScopes(left: PassScope, right: PassScope): PassScope {
  if (left.full || right.full) return FULL_SCOPE;
  return { full: false, threadKeys: new Set([...left.threadKeys, ...right.threadKeys]) };
}

import { type Background, inPlace } from "./background.js";

export class PassRunner {
  readonly #execute: (scope: PassScope) => Promise<void>;
  readonly #onError: (error: unknown) => void;
  readonly #background: Background;
  #pending: PassScope | null = null;
  #pendingWaiters: Array<() => void> = [];
  #running = false;
  #disposed = false;

  constructor(
    execute: (scope: PassScope) => Promise<void>,
    onError: (error: unknown) => void,
    background: Background = inPlace,
  ) {
    this.#execute = execute;
    this.#onError = onError;
    this.#background = background;
  }

  request(scope: PassScope): Promise<void> {
    if (this.#disposed) return Promise.resolve();
    this.#pending = this.#pending === null ? scope : mergeScopes(this.#pending, scope);
    const done = new Promise<void>((resolve) => this.#pendingWaiters.push(resolve));
    if (!this.#running) {
      this.#running = true;
      void this.#background.run(() => this.#drain());
    }
    return done;
  }

  dispose(): void {
    this.#disposed = true;
    this.#pending = null;
    const waiters = this.#pendingWaiters;
    this.#pendingWaiters = [];
    for (const resolve of waiters) resolve();
  }

  async #drain(): Promise<void> {
    if (this.#pending === null || this.#disposed) {
      this.#running = false;
      return;
    }
    this.#running = true;
    const scope = this.#pending;
    const waiters = this.#pendingWaiters;
    this.#pending = null;
    this.#pendingWaiters = [];
    try {
      await this.#execute(scope);
    } catch (error) {
      this.#onError(error);
    } finally {
      for (const resolve of waiters) resolve();
    }
    return this.#drain();
  }
}
