import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { run } from "./main-protection.mjs";

const text = readFileSync(new URL("../../.github/main-protection.json", import.meta.url), "utf8");
const wanted = JSON.parse(text);
const REPOSITORY = "repos/1ma-ai/1ma";
const PROTECTION = `${REPOSITORY}/branches/main/protection`;

// GitHub as the script sees it through gh: what it answers and what was asked.
function github(change = () => {}) {
  const on = (enabled) => ({ url: "https://api.github.com/x", enabled });
  const state = {
    actions: { ...wanted.actions, selected_actions_url: "https://api.github.com/x" },
    protection: {
      url: "https://api.github.com/x",
      required_status_checks: {
        url: "https://api.github.com/x",
        strict: false,
        contexts: wanted.protection.required_status_checks.checks.map((check) => check.context),
        checks: structuredClone(wanted.protection.required_status_checks.checks).toReversed(),
      },
      enforce_admins: on(true),
      required_signatures: on(false),
      required_linear_history: { enabled: false },
      allow_force_pushes: { enabled: false },
      allow_deletions: { enabled: false },
      block_creations: { enabled: false },
      required_conversation_resolution: { enabled: false },
      lock_branch: { enabled: false },
      allow_fork_syncing: { enabled: false },
    },
    rules: [],
    file: text,
    fails: {},
  };
  change(state);
  const asked = [];
  const refuse = (message, status) => ({
    status: 1,
    stdout: JSON.stringify({ message, status: String(status) }),
    stderr: `gh: ${message} (HTTP ${status})\n`,
  });
  const answer = (value) => ({ status: 0, stdout: JSON.stringify(value), stderr: "" });
  const gh = (args, input) => {
    const [, , method, address] = args;
    const body = args.includes("--input") ? JSON.parse(input) : undefined;
    asked.push({ method, address, body });
    const failure = state.fails[`${method} ${address}`];
    if (failure !== undefined) return refuse(...failure);
    if (method === "GET") {
      if (address === `${REPOSITORY}/actions/permissions`) return answer(state.actions);
      if (address === PROTECTION)
        return state.protection === null
          ? refuse("Branch not protected", 404)
          : answer(state.protection);
      if (address === `${REPOSITORY}/rules/branches/main`) return answer(state.rules);
      if (address === `${REPOSITORY}/contents/.github/main-protection.json?ref=main`)
        return state.file === null
          ? refuse("Not Found", 404)
          : answer({ content: Buffer.from(state.file).toString("base64"), encoding: "base64" });
    }
    if (method === "PUT" && address === `${REPOSITORY}/actions/permissions`) {
      state.actions = { ...state.actions, ...body };
      return { status: 0, stdout: "", stderr: "" };
    }
    if (method === "PUT" && address === PROTECTION) {
      const { required_status_checks: checks, ...rest } = body;
      state.protection = {
        required_status_checks: checks,
        required_signatures: on(state.protection?.required_signatures.enabled ?? false),
        ...Object.fromEntries(
          Object.entries(rest).flatMap(([name, value]) =>
            typeof value === "boolean" ? [[name, { enabled: value }]] : [],
          ),
        ),
      };
      return answer(state.protection);
    }
    if (method === "PATCH" && address === `${PROTECTION}/required_status_checks`) {
      state.protection.required_status_checks = body;
      return answer(body);
    }
    if (address === `${PROTECTION}/required_signatures` && method !== "GET") {
      state.protection.required_signatures = on(method === "POST");
      return method === "POST" ? answer(on(true)) : { status: 0, stdout: "", stderr: "" };
    }
    throw new Error(`the test's GitHub has no answer for ${method} ${address}`);
  };
  const output = [];
  const call = (apply = false) => run({ apply, gh, text, log: (line) => output.push(line) });
  const written = () => asked.filter((entry) => entry.method !== "GET");
  return { state, asked, output, call, written };
}

describe("comparing GitHub with the file", () => {
  test("agrees when GitHub enforces what the file says, and writes nothing", () => {
    const hub = github();
    assert.equal(hub.call(), 0);
    assert.match(hub.output.join("\n"), /main of 1ma-ai\/1ma is protected as/u);
    assert.deepEqual(hub.written(), []);
  });

  test("names every on/off setting that somebody switched on outside the file", () => {
    for (const name of [
      "lock_branch",
      "block_creations",
      "allow_fork_syncing",
      "required_linear_history",
      "a_setting_github_adds_later",
    ]) {
      const hub = github((state) => {
        state.protection[name] = { enabled: true };
      });
      assert.equal(hub.call(), 1, name);
      assert.deepEqual(
        hub.output.slice(1),
        [`- protection.${name}: GitHub has true, the file says false`],
        name,
      );
    }
  });

  test("names signed commits required outside the file", () => {
    const hub = github((state) => {
      state.protection.required_signatures.enabled = true;
    });
    assert.equal(hub.call(), 1);
    assert.match(hub.output.join("\n"), /- required_signatures: GitHub has true/u);
  });

  test("names a setting the file wants and GitHub has off, a lost source app, a review rule", () => {
    const hub = github((state) => {
      state.protection.enforce_admins.enabled = false;
      state.protection.required_status_checks.checks[0].app_id = null;
      state.protection.required_pull_request_reviews = { required_approving_review_count: 1 };
    });
    assert.equal(hub.call(), 1);
    const output = hub.output.join("\n");
    assert.match(output, /- protection\.enforce_admins: GitHub has false, the file says true/u);
    assert.match(output, /- protection\.required_status_checks: GitHub has .*"app_id":null/u);
    assert.match(output, /- protection\.required_pull_request_reviews: GitHub has \{/u);
  });

  test("names a rule a ruleset adds for the branch", () => {
    const hub = github((state) => {
      state.rules = [{ type: "pull_request", ruleset_id: 7, ruleset_source: "1ma-ai/1ma" }];
    });
    assert.equal(hub.call(), 1);
    assert.match(hub.output.join("\n"), /- rules: GitHub has \[\{"type":"pull_request"/u);
  });

  test("reports a branch without protection as a difference, with the Actions difference found before it", () => {
    const hub = github((state) => {
      state.protection = null;
      state.actions.sha_pinning_required = false;
    });
    assert.equal(hub.call(), 1);
    const output = hub.output.join("\n");
    assert.match(output, /- actions\.sha_pinning_required: GitHub has false, the file says true/u);
    assert.match(output, /- protection: GitHub has null/u);
  });

  test("does not take an answer it could not read for a difference", () => {
    for (const address of [PROTECTION, `${REPOSITORY}/actions/permissions`]) {
      const hub = github((state) => {
        state.fails[`GET ${address}`] = ["Resource not accessible by personal access token", 403];
      });
      assert.throws(() => hub.call(), /Resource not accessible/u, address);
      assert.deepEqual(hub.output, []);
    }
    const missing = github((state) => {
      state.fails[`GET ${PROTECTION}`] = ["Branch not found", 404];
    });
    assert.throws(() => missing.call(), /Branch not found/u);
  });

  test("asks only about the repository the file names", () => {
    const hub = github();
    hub.call();
    assert.ok(hub.asked.length >= 3);
    for (const { address } of hub.asked) assert.ok(address.startsWith(`${REPOSITORY}/`), address);
  });
});

describe("applying the file", () => {
  test("writes nothing without --apply", () => {
    const hub = github((state) => {
      state.protection = null;
    });
    assert.equal(hub.call(false), 1);
    assert.deepEqual(hub.written(), []);
  });

  test("protects a branch that has no protection and sets the Actions settings", () => {
    const hub = github((state) => {
      state.protection = null;
      state.actions.sha_pinning_required = false;
    });
    assert.equal(hub.call(true), 0);
    assert.deepEqual(
      hub.written().map(({ method, address }) => `${method} ${address}`),
      [`PUT ${REPOSITORY}/actions/permissions`, `PUT ${PROTECTION}`],
    );
    assert.deepEqual(hub.written()[1].body, wanted.protection);
    assert.match(hub.output.join("\n"), /Written: actions, branch protection\./u);
    assert.match(hub.output.at(-1), /is now protected as the file says/u);
  });

  test("restores one required check without a request about any other setting", () => {
    const hub = github((state) => {
      state.protection.required_status_checks.checks.pop();
    });
    assert.equal(hub.call(true), 0);
    assert.deepEqual(hub.written(), [
      {
        method: "PATCH",
        address: `${PROTECTION}/required_status_checks`,
        body: wanted.protection.required_status_checks,
      },
    ]);
  });

  test("writes the whole protection when a setting beside the checks differs", () => {
    const hub = github((state) => {
      state.protection.required_status_checks.strict = true;
      state.protection.lock_branch.enabled = true;
    });
    assert.equal(hub.call(true), 0);
    assert.deepEqual(
      hub.written().map(({ method, address }) => `${method} ${address}`),
      [`PUT ${PROTECTION}`],
    );
  });

  test("switches required signatures off through their own address", () => {
    const hub = github((state) => {
      state.protection.required_signatures.enabled = true;
    });
    assert.equal(hub.call(true), 0);
    assert.deepEqual(hub.written(), [
      { method: "DELETE", address: `${PROTECTION}/required_signatures`, body: undefined },
    ]);
  });

  test("refuses a file that is not the one on main, before any write", () => {
    for (const file of [text.replace('"strict": false', '"strict": true'), null]) {
      const hub = github((state) => {
        state.protection = null;
        state.file = file;
      });
      assert.equal(hub.call(true), 1);
      assert.deepEqual(hub.written(), []);
      assert.match(hub.output.at(-1), /Nothing was changed: .* is not the file on main of/u);
    }
  });

  test("says what was written when a later write fails, and reads both states again", () => {
    const hub = github((state) => {
      state.protection = null;
      state.actions.sha_pinning_required = false;
      state.fails[`PUT ${PROTECTION}`] = ["Validation Failed", 422];
    });
    assert.equal(hub.call(true), 1);
    const output = hub.output.join("\n");
    assert.match(output, /Writing branch protection failed: PUT .*: Validation Failed/u);
    assert.match(output, /Already written: actions\./u);
    assert.match(output, /GitHub still differs from the file:\n- protection: GitHub has null/u);
    assert.doesNotMatch(output.split("GitHub still differs")[1], /actions\./u);
    const afterFailure = hub.asked.slice(
      hub.asked.findLastIndex((entry) => entry.method === "PUT"),
    );
    assert.deepEqual(
      afterFailure.slice(1).map(({ method, address }) => `${method} ${address}`),
      [
        `GET ${REPOSITORY}/actions/permissions`,
        `GET ${PROTECTION}`,
        `GET ${REPOSITORY}/rules/branches/main`,
      ],
    );
  });

  test("stops at the first failed write and says nothing was written", () => {
    const hub = github((state) => {
      state.protection = null;
      state.actions.sha_pinning_required = false;
      state.fails[`PUT ${REPOSITORY}/actions/permissions`] = ["Must have admin rights", 403];
    });
    assert.equal(hub.call(true), 1);
    assert.equal(hub.written().length, 1);
    assert.match(hub.output.join("\n"), /Nothing was written\./u);
  });

  test("cannot remove a rule of a ruleset, and says so", () => {
    const hub = github((state) => {
      state.rules = [{ type: "deletion", ruleset_id: 3 }];
    });
    assert.equal(hub.call(true), 1);
    assert.deepEqual(hub.written(), []);
    assert.match(hub.output.at(-1), /this script does not change them/u);
  });
});
