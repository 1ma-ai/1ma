import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  getPreferenceDefault,
  PREFERENCE_KEYS,
  type PreferenceKey,
} from "../shared/preferences.js";
import { strings } from "./strings.js";

export const BUILT_IN_THREAD_LIST = "thread-list";
const COPIED_KV_KEY = "1ma/copied-built-in-preferences";

interface PreferenceWriter {
  write(key: PreferenceKey, value: unknown, origin: string | null): Promise<unknown>;
  /** The value stored in this plugin for the key, undefined when none. */
  stored(key: PreferenceKey): Promise<unknown>;
}

export function register1maSidebar(bb: BbPluginApi, store: PreferenceWriter) {
  bb.settings.define({
    showBots: {
      type: "boolean",
      label: strings.settings.showBots,
      description: strings.settings.showBotsDescription,
      default: true,
    },
  });

  // Copies the owner's layout from the built-in thread list once. It is tried
  // at load, before bb's migration of old sidebar.* settings, so the built-in
  // list's newer values come first; if the built-in list is not loaded yet,
  // again on the first read from the app. Keys already stored here are never
  // overwritten.
  let pending: Promise<void> | null = null;
  const copyBuiltInPreferences = () => {
    pending ??= copyOnce(bb, store).catch((error: unknown) => {
      pending = null;
      bb.log.warn(
        `could not read the built-in thread list's preferences: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
    return pending;
  };
  return { copyBuiltInPreferences };
}

async function copyOnce(bb: BbPluginApi, store: PreferenceWriter): Promise<void> {
  if ((await bb.storage.kv.get<boolean>(COPIED_KV_KEY)) === true) return;
  const installed = await bb.sdk.plugins.list();
  const builtIn = installed.plugins.find((plugin) => plugin.id === BUILT_IN_THREAD_LIST);
  if (builtIn !== undefined && builtIn.enabled !== false) {
    const result = await bb.sdk.plugins.callRpc({
      pluginId: BUILT_IN_THREAD_LIST,
      method: "listPreferences",
      input: null,
      outputSchema: z.object({ preferences: z.record(z.string(), z.unknown()) }),
    });
    const copied: string[] = [];
    for (const key of PREFERENCE_KEYS) {
      const value = result.preferences[key];
      if (
        value === undefined ||
        JSON.stringify(value) === JSON.stringify(getPreferenceDefault(key))
      ) {
        continue;
      }
      if ((await store.stored(key)) !== undefined) continue;
      await store.write(key, value, null);
      copied.push(key);
    }
    if (copied.length > 0) bb.log.info(strings.migratedPreferences(copied));
  }
  await bb.storage.kv.set(COPIED_KV_KEY, true);
}
