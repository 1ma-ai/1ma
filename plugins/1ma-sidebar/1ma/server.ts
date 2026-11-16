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
const CHOSEN_KV_KEY = "1ma/keys-the-owner-chose";

interface PreferenceStore {
  write(key: PreferenceKey, value: unknown, origin: string | null): Promise<unknown>;
  reset(key: PreferenceKey): Promise<unknown>;
}

// Whether the owner chose a key here (RPC or CLI) decides whether the
// built-in list's layout may replace it: anything else stored, such as values
// migrated from bb's old sidebar.* settings, gives way to the built-in list.
export function register1maSidebar<Store extends PreferenceStore>(bb: BbPluginApi, raw: Store) {
  const chosen = async () => new Set((await bb.storage.kv.get<string[]>(CHOSEN_KV_KEY)) ?? []);
  const choose = async (key: PreferenceKey) => {
    const keys = await chosen();
    if (keys.has(key)) return;
    keys.add(key);
    await bb.storage.kv.set(CHOSEN_KV_KEY, [...keys]);
  };
  const store: Store = {
    ...raw,
    write: async (key: PreferenceKey, value: unknown, origin: string | null) => {
      const written = await raw.write(key, value, origin);
      await choose(key);
      return written;
    },
    reset: async (key: PreferenceKey) => {
      const reset = await raw.reset(key);
      await choose(key);
      return reset;
    },
  };

  bb.settings.define({
    showBots: {
      type: "boolean",
      label: strings.settings.showBots,
      description: strings.settings.showBotsDescription,
      default: true,
    },
  });

  // Copies the owner's layout from the built-in thread list once. It is tried
  // at load, and once it succeeds bb's old sidebar.* settings are not
  // migrated at all: the built-in list already holds their newer state. If
  // the built-in list is not loaded yet (bb loads plugins by id), it is tried
  // again on the first read from the app and then replaces what came from
  // old settings, but never a key the owner chose here.
  let pending: Promise<void> | null = null;
  const copyBuiltInPreferences = () => {
    pending ??= copyOnce(bb, raw, chosen).catch((error: unknown) => {
      pending = null;
      bb.log.warn(
        `could not read the built-in thread list's preferences: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
    return pending;
  };
  return {
    store,
    copyBuiltInPreferences,
    copiedFromBuiltIn: async () => (await bb.storage.kv.get<boolean>(COPIED_KV_KEY)) === true,
  };
}

// The built-in list's own row actions (thread-list/move) are this plugin's
// own here (1ma-sidebar/move); a copied key must not depend on the built-in
// plugin staying enabled.
const BUILT_IN_ACTION_PREFIX = `${BUILT_IN_THREAD_LIST}/`;
const OWN_ACTION_PREFIX = "1ma-sidebar/";

export function ownActionKeys(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((item: unknown) =>
    typeof item === "string" && item.startsWith(BUILT_IN_ACTION_PREFIX)
      ? `${OWN_ACTION_PREFIX}${item.slice(BUILT_IN_ACTION_PREFIX.length)}`
      : item,
  );
}

async function copyOnce(
  bb: BbPluginApi,
  store: PreferenceStore,
  chosen: () => Promise<ReadonlySet<string>>,
): Promise<void> {
  if ((await bb.storage.kv.get<boolean>(COPIED_KV_KEY)) === true) return;
  const installed = await bb.sdk.plugins.list();
  const builtIn = installed.plugins.find((plugin) => plugin.id === BUILT_IN_THREAD_LIST);
  // Nothing to copy from a missing or disabled list: the copy is not done,
  // so bb's old sidebar.* settings still migrate, and a list enabled later
  // is copied then.
  if (builtIn === undefined || builtIn.enabled === false) return;
  {
    const result = await bb.sdk.plugins.callRpc({
      pluginId: BUILT_IN_THREAD_LIST,
      method: "listPreferences",
      input: null,
      outputSchema: z.object({ preferences: z.record(z.string(), z.unknown()) }),
    });
    const ownerChose = await chosen();
    const copied: string[] = [];
    for (const key of PREFERENCE_KEYS) {
      const value = ownActionKeys(result.preferences[key]);
      if (value === undefined || ownerChose.has(key)) continue;
      if (JSON.stringify(value) === JSON.stringify(getPreferenceDefault(key)))
        await store.reset(key);
      else await store.write(key, value, null);
      copied.push(key);
    }
    if (copied.length > 0) bb.log.info(strings.migratedPreferences(copied));
  }
  await bb.storage.kv.set(COPIED_KV_KEY, true);
}
