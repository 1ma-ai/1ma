// The decisions of scripts/release-linux.mjs, kept free of process and network
// access so they can be tested: which arguments are accepted, whether a commit
// may be deployed, and the install loop with its rollback and theme restore.

const FLAGS = new Set(["--replace-managed"]);

export function parseArgs(argv) {
  const unknown = argv.filter((arg) => arg.startsWith("-") && !FLAGS.has(arg));
  if (unknown.length > 0) throw new Error(`unknown option ${unknown.join(", ")}`);
  const refs = argv.filter((arg) => !arg.startsWith("-"));
  if (refs.length > 1) throw new Error(`expected at most one ref, got ${refs.join(", ")}`);
  return { ref: refs[0] ?? "origin/main", replaceManaged: argv.includes("--replace-managed") };
}

// A commit may be deployed only if it is on main and the newest CI run of
// that commit on main succeeded.
export function deployable({ sha, onMain, latestCiRun }) {
  if (!/^[0-9a-f]{40}$/.test(sha)) return `cannot resolve the ref to a commit (${sha})`;
  if (!onMain) return `${sha} is not on origin/main`;
  if (latestCiRun === null) return `no CI run on main for ${sha} yet`;
  if (latestCiRun.status !== "completed") return `CI for ${sha} is still ${latestCiRun.status}`;
  if (latestCiRun.conclusion !== "success")
    return `CI for ${sha} finished with ${latestCiRun.conclusion}`;
  return null;
}

// The source a plugin is installed from, as `bb plugin source --json` reports
// it: null when the plugin is not installed, "unknown" when bb does not say.
export function installedSource(json) {
  if (json === null) return null;
  const requested = JSON.parse(json).requested;
  return typeof requested === "string" && requested.length > 0 ? requested : "unknown";
}

// Installs each plugin from its directory in the release worktree. A plugin
// installed from git or npm is replaced only with replaceManaged; if its new
// install fails, the previous install is put back so the plugin is not left
// missing. The active theme is restored whatever happens.
export function deployPlugins({ entries, replaceManaged, bb, log }) {
  const blocked = [];
  const themeBefore = bb.activeTheme();
  try {
    for (const { id, directory, version } of entries) {
      const current = bb.source(id);
      const managed = current !== null && !current.startsWith("path:");
      if (managed && !replaceManaged) {
        blocked.push(`${id} (installed from ${current})`);
        continue;
      }
      if (managed) {
        bb.remove(id);
        log(`${id}: removed managed install ${current}`);
      }
      try {
        bb.install(directory);
      } catch (error) {
        if (!managed) throw error;
        if (current === "unknown") {
          throw new Error(
            `${id}: install from ${directory} failed and the previous source is unknown, so the plugin is not installed now: ${error.message}`,
            { cause: error },
          );
        }
        try {
          bb.install(current);
          log(`${id}: install failed, put back ${current} (its settings were removed)`);
        } catch (restoreError) {
          throw new Error(
            `${id}: install from ${directory} failed (${error.message}) and putting back ${current} failed too (${restoreError.message})`,
            { cause: restoreError },
          );
        }
        throw error;
      }
      log(`${id}@${version}: installed from ${directory}`);
    }
  } finally {
    const themeAfter = bb.activeTheme();
    if (themeBefore !== null && themeAfter !== themeBefore) {
      bb.setTheme(themeBefore);
      log(`theme restored to ${themeBefore}`);
    }
  }
  return blocked;
}
