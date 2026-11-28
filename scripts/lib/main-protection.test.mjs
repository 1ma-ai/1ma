import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { ghRunner, run } from "./main-protection.mjs";

const text = readFileSync(new URL("../../.github/main-protection.json", import.meta.url), "utf8");
const wanted = JSON.parse(text);
const REPOSITORY = "repos/1ma-ai/1ma";
const PROTECTION = `${REPOSITORY}/branches/main/protection`;
const ACTIONS = `${REPOSITORY}/actions/permissions`;
const RULES = `${REPOSITORY}/rules/branches/main`;
const FILE = `${REPOSITORY}/contents/.github/main-protection.json?ref=main`;
const PROTECTION_URL = `https://api.github.com/${PROTECTION}`;
const REVIEW_RULE = { dismiss_stale_reviews: false, require_code_owner_reviews: true };
const PUSH_RESTRICTIONS = {
  url: `${PROTECTION_URL}/restrictions`,
  users_url: `${PROTECTION_URL}/restrictions/users`,
  teams_url: `${PROTECTION_URL}/restrictions/teams`,
  apps_url: `${PROTECTION_URL}/restrictions/apps`,
  users: [],
  teams: [],
  apps: [],
};

// An answer as gh --include prints it: the status line, the headers, an empty
// line, the body.
const HEADER = "X-Github-Request-Id: 0A1B:2C3D:4E5F";
const included = (status, body = "") =>
  `HTTP/2.0 ${status} ${status < 300 ? "OK" : "Error"}\n` +
  `Content-Type: application/json; charset=utf-8\r\n${HEADER}\r\n\r\n${body}`;
const bodyOf = (stdout) => stdout.slice(stdout.indexOf("\r\n\r\n") + 4);
const empty = () => ({ status: 0, stdout: included(204), stderr: "" });

// The classic rule of the branch as GraphQL gives it.
function ruleOf(classic) {
  if (classic === null) return null;
  const { bypass, ...rest } = classic;
  return {
    ...rest,
    bypassForcePushAllowances: {
      pageInfo: { hasNextPage: false },
      nodes: bypass.map((actor) => ({ actor })),
    },
  };
}

// GitHub as the script sees it through gh: what it answers and what was asked.
function github(change = () => {}) {
  const on = (enabled) => ({ url: "https://api.github.com/x", enabled });
  const url = PROTECTION_URL;
  const state = {
    name: wanted.repository,
    actions: { ...wanted.actions, selected_actions_url: "https://api.github.com/x" },
    protection: {
      url,
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
    branch: true,
    classic: { requiresDeployments: false, requiredDeploymentEnvironments: [], bypass: [] },
    queue: null,
    file: text,
    fails: {},
    answers: {},
    unreachable: new Set(),
  };
  change(state);
  const asked = [];
  const calls = [];
  const refuse = (message, status) => ({
    status: 1,
    stdout: included(status, JSON.stringify({ message, status: String(status) })),
    stderr: `gh: ${message} (HTTP ${status})\n`,
  });
  const answer = (value) => ({
    status: 0,
    stdout: included(200, JSON.stringify(value)),
    stderr: "",
  });
  const gh = (args, input) => {
    if (!args.includes("--include")) throw new Error(`gh ${args.join(" ")}: no status line asked`);
    const at = args.indexOf("-X");
    const [method, address] = args.slice(at + 1, at + 3);
    const body = args.includes("--input") ? JSON.parse(input) : undefined;
    calls.push(args);
    asked.push({ method, address, body });
    const key = `${method} ${address}`;
    if (state.unreachable.has(key)) throw new Error("spawnSync gh ENOENT");
    const failure = state.fails[key];
    if (failure !== undefined) return refuse(...failure);
    const given = state.answers[key];
    if (given === undefined) return respond(method, address, body);
    delete state.answers[key];
    return given(state, () => respond(method, address, body));
  };
  const respond = (method, address, body) => {
    if (method === "GET") {
      if (address === REPOSITORY) return answer({ full_name: state.name, private: false });
      if (address === ACTIONS) return answer(state.actions);
      if (address === PROTECTION)
        return state.protection === null
          ? refuse("Branch not protected", 404)
          : answer(state.protection);
      if (address === RULES) return answer(state.rules);
      if (address === FILE)
        return state.file === null
          ? refuse("Not Found", 404)
          : answer({ content: Buffer.from(state.file).toString("base64"), encoding: "base64" });
    }
    if (method === "POST" && address === "graphql") {
      return answer({
        data: {
          repository: {
            mergeQueue: state.queue,
            ref: state.branch
              ? { branchProtectionRule: state.protection === null ? null : ruleOf(state.classic) }
              : null,
          },
        },
      });
    }
    if (method === "PUT" && address === ACTIONS) {
      state.actions = { ...state.actions, ...body };
      return empty();
    }
    if (method === "PUT" && address === PROTECTION) {
      const { required_status_checks: checks, ...rest } = body;
      state.protection = {
        url,
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
      return method === "POST" ? answer(on(true)) : empty();
    }
    throw new Error(`the test's GitHub has no answer for ${method} ${address}`);
  };
  const output = [];
  const call = (apply = false) => run({ apply, gh, text, log: (line) => output.push(line) });
  const written = () =>
    asked.filter((entry) => entry.method !== "GET" && entry.address !== "graphql");
  return { state, asked, calls, output, call, written };
}

// GitHub's answer to the GraphQL question with one part of it changed.
const partly = (change) => (_, read) => {
  const answer = JSON.parse(bodyOf(read().stdout));
  change(answer.data.repository);
  return { status: 0, stdout: included(200, JSON.stringify(answer)), stderr: "" };
};

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
      state.protection.required_pull_request_reviews = {
        ...REVIEW_RULE,
        required_approving_review_count: 1,
      };
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
    for (const [given, error] of [
      [{ status: 0, stdout: included(200, '{"enabled":'), stderr: "" }, /could not be read/u],
      [{ status: 1, stdout: "", stderr: "gh: connection refused\n" }, /no answer/u],
    ]) {
      const hub = github((state) => {
        state.answers[`GET ${ACTIONS}`] = () => given;
      });
      assert.throws(() => hub.call(), error);
      assert.deepEqual(hub.output, []);
    }
  });

  test("asks only about the repository the file names", () => {
    const hub = github();
    hub.call();
    assert.ok(hub.asked.length >= 4);
    for (const { address, body } of hub.asked)
      if (address === "graphql")
        assert.deepEqual(body.variables, {
          owner: "1ma-ai",
          name: "1ma",
          branch: "main",
          ref: "refs/heads/main",
        });
      else assert.ok(address === REPOSITORY || address.startsWith(`${REPOSITORY}/`), address);
  });

  test("names a deployment a classic rule for the branch requires, which the REST answer leaves out", () => {
    const hub = github((state) => {
      state.classic.requiresDeployments = true;
      state.classic.requiredDeploymentEnvironments = ["production"];
    });
    assert.equal(hub.call(), 1);
    assert.deepEqual(hub.output.slice(1), [
      '- required_deployment_environments: GitHub has ["production"], the file says []',
    ]);
  });

  test("refuses a branch GraphQL says GitHub does not have", () => {
    const gone = github((state) => {
      state.branch = false;
    });
    assert.throws(() => gone.call(), /1ma-ai\/1ma has no branch main/u);
    assert.deepEqual(gone.output, []);
  });

  test("names who may force push past the protection, which the REST answer leaves out", () => {
    const hub = github((state) => {
      state.classic.bypass = [
        { kind: "User", login: "somebody" },
        { kind: "Team", combinedSlug: "1ma-ai/release" },
        { kind: "App", slug: "a-bot" },
        null,
      ];
    });
    assert.equal(hub.call(), 1);
    assert.deepEqual(hub.output.slice(1), [
      "- bypass_force_push_allowances: GitHub has " +
        '["Actor:unknown","App:a-bot","Team:1ma-ai/release","User:somebody"], the file says []',
    ]);
  });

  test("names a merge queue switched on for the branch", () => {
    const hub = github((state) => {
      state.queue = { id: "MQ_1" };
    });
    assert.equal(hub.call(), 1);
    assert.deepEqual(hub.output.slice(1), ["- merge_queue: GitHub has true, the file says false"]);
  });

  test("does not take a GraphQL answer it could not read for agreement", () => {
    const broken = [
      partly((repository) => {
        delete repository.mergeQueue;
      }),
      partly((repository) => {
        delete repository.ref;
      }),
      partly((repository) => {
        delete repository.ref.branchProtectionRule;
      }),
      partly((repository) => {
        repository.ref.branchProtectionRule.bypassForcePushAllowances.pageInfo.hasNextPage = true;
      }),
      partly((repository) => {
        delete repository.ref.branchProtectionRule.bypassForcePushAllowances;
      }),
      partly((repository) => {
        delete repository.ref.branchProtectionRule.requiresDeployments;
      }),
      partly((repository) => {
        repository.ref.branchProtectionRule.requiresDeployments = "false";
      }),
      partly((repository) => {
        delete repository.ref.branchProtectionRule.bypassForcePushAllowances.pageInfo.hasNextPage;
      }),
      partly((repository) => {
        repository.mergeQueue = "MQ_1";
      }),
      partly((repository) => {
        const rule = repository.ref.branchProtectionRule;
        delete rule.requiresDeployments;
        rule.requiredDeploymentEnvironments = ["production"];
        rule.bypassForcePushAllowances.pageInfo = {};
      }),
      () => ({ status: 0, stdout: included(200, '{"data":{"repository":null}}'), stderr: "" }),
      () => ({
        status: 0,
        stdout: included(200, JSON.stringify({ errors: [{ message: "Something went wrong" }] })),
        stderr: "",
      }),
    ];
    for (const given of broken) {
      const hub = github((state) => {
        state.answers["POST graphql"] = given;
      });
      assert.throws(() => hub.call(), /branch protection rule of main could not be read/u);
      assert.deepEqual(hub.output, []);
    }
    const failed = github((state) => {
      state.answers["POST graphql"] = () => ({
        status: 1,
        stdout: included(200, JSON.stringify({ errors: [{ message: "Something went wrong" }] })),
        stderr: "gh: Something went wrong\n",
      });
    });
    assert.throws(() => failed.call(), /POST graphql: the answer could not be read \(HTTP 200\)/u);
  });

  test("does not read a protection whose fields are not of their documented types, and writes nothing", () => {
    const wrong = {
      "a switch whose enabled is a string": (protection) => {
        protection.allow_force_pushes = { enabled: "true" };
      },
      "a switch nobody names whose enabled is a string": (protection) => {
        protection.a_setting_github_adds_later = { enabled: "yes" };
      },
      "a switch the file names that is not an object": (protection) => {
        protection.enforce_admins = true;
      },
      "signatures that are not a switch": (protection) => {
        protection.required_signatures = {};
      },
      "an empty object": (protection) => {
        for (const key of Object.keys(protection)) delete protection[key];
      },
      "no url": (protection) => {
        delete protection.url;
      },
      "the url of another branch": (protection) => {
        protection.url = `https://api.github.com/${REPOSITORY}/branches/develop/protection`;
      },
      "a strict that is not a boolean": (protection) => {
        protection.required_status_checks.strict = "false";
      },
      "contexts without checks": (protection) => {
        delete protection.required_status_checks.checks;
      },
      "a check without its context": (protection) => {
        delete protection.required_status_checks.checks[0].context;
      },
      "an app id that is not an integer": (protection) => {
        protection.required_status_checks.checks[0].app_id = "15368";
      },
    };
    for (const [what, change] of Object.entries(wrong)) {
      const hub = github((state) => {
        change(state.protection);
      });
      assert.throws(
        () => hub.call(true),
        (error) => error.message === `GET ${PROTECTION}: the answer could not be read (HTTP 200)`,
        what,
      );
      assert.deepEqual(hub.written(), [], what);
      assert.deepEqual(hub.output, [], what);
    }
  });

  test("takes a switch GitHub leaves out of the protection for off", () => {
    const hub = github((state) => {
      for (const name of ["required_signatures", "lock_branch", "block_creations"])
        delete state.protection[name];
    });
    assert.equal(hub.call(), 0);
    const on = github((state) => {
      delete state.protection.enforce_admins;
    });
    assert.equal(on.call(), 1);
    assert.deepEqual(on.output.slice(1), [
      "- protection.enforce_admins: GitHub has false, the file says true",
    ]);
  });

  for (const [field, malformed] of [
    ["required_pull_request_reviews", false],
    ["restrictions", "off"],
  ]) {
    test(`refuses to apply from a protection with ${field} of the wrong type`, () => {
      const hub = github((state) => {
        state.protection[field] = malformed;
      });
      assert.throws(() => hub.call(true), {
        message: `GET ${PROTECTION}: the answer could not be read (HTTP 200)`,
      });
      assert.deepEqual(hub.written(), []);
    });
  }

  test("takes null and absent review rules and push restrictions for off", () => {
    const withNulls = github((state) => {
      state.protection.required_pull_request_reviews = null;
      state.protection.restrictions = null;
    });
    for (const hub of [github(), withNulls]) {
      assert.equal(hub.call(true), 0);
      assert.deepEqual(hub.written(), []);
    }
  });

  test("does not read Actions settings of the wrong type, and takes one GitHub leaves out for a difference", () => {
    for (const actions of [
      { enabled: "true", allowed_actions: "all", sha_pinning_required: true },
      { allowed_actions: "all", sha_pinning_required: true },
      { enabled: true, allowed_actions: "all", sha_pinning_required: "yes" },
      { enabled: true, allowed_actions: null, sha_pinning_required: true },
    ]) {
      const hub = github((state) => {
        state.actions = actions;
      });
      assert.throws(
        () => hub.call(true),
        (error) => error.message === `GET ${ACTIONS}: the answer could not be read (HTTP 200)`,
        JSON.stringify(actions),
      );
      assert.deepEqual(hub.written(), []);
    }
    const off = github((state) => {
      state.actions = { enabled: false };
    });
    assert.equal(off.call(), 1);
    assert.deepEqual(off.output.slice(1), [
      "- actions.enabled: GitHub has false, the file says true",
      '- actions.allowed_actions: GitHub reports no value, the file says "all"',
      "- actions.sha_pinning_required: GitHub reports no value, the file says true",
    ]);
  });

  test("takes only GitHub's own message Branch not protected for a branch without protection", () => {
    for (const message of ["Branch not protected by this ruleset", "Not Found: not protected"]) {
      const hub = github((state) => {
        state.fails[`GET ${PROTECTION}`] = [message, 404];
      });
      assert.throws(() => hub.call(true), new RegExp(`${message} \\(HTTP 404\\)`, "u"), message);
      assert.deepEqual(hub.written(), [], message);
      assert.deepEqual(hub.output, [], message);
    }
  });

  test("asks github.com whatever host gh would choose", () => {
    const hub = github((state) => {
      state.protection = null;
      state.actions.sha_pinning_required = false;
    });
    assert.equal(hub.call(true), 0);
    assert.ok(hub.calls.length > 10);
    for (const args of hub.calls) {
      const at = args.indexOf("--hostname");
      assert.ok(at !== -1 && args[at + 1] === "github.com", args.join(" "));
    }
  });

  test("stops before anything else is read when GitHub answers for another repository", () => {
    for (const apply of [false, true]) {
      const hub = github((state) => {
        state.name = "1ma-ai/renamed";
        state.protection = null;
      });
      assert.throws(
        () => hub.call(apply),
        /GitHub answers for 1ma-ai\/renamed, not for 1ma-ai\/1ma, .*correct "repository"/u,
      );
      assert.deepEqual(hub.asked, [{ method: "GET", address: REPOSITORY, body: undefined }]);
      assert.deepEqual(hub.output, []);
    }
  });

  test("does not take an answer that was not read whole, or not of its kind, for a state of GitHub", () => {
    const kept = (change) => (_, read) => change(read());
    const cut = {
      "an empty body": () => ({ status: 0, stdout: included(200), stderr: "" }),
      "a body cut short": kept((done) => ({ ...done, stdout: done.stdout.slice(0, -3) })),
      "a status line from a gh that failed": kept((done) => ({
        ...done,
        status: 1,
        stderr: "gh: unexpected EOF\n",
      })),
      null: () => ({ status: 0, stdout: included(200, "null"), stderr: "" }),
    };
    const kinds = {
      [`GET ${REPOSITORY}`]: [[], { private: false }],
      [`GET ${ACTIONS}`]: [[], { allowed_actions: "all", sha_pinning_required: true }],
      [`GET ${PROTECTION}`]: [[], { required_status_checks: { checks: [null] } }],
      [`GET ${RULES}`]: [{}, [null]],
      ["POST graphql"]: [[]],
      [`GET ${FILE}`]: [[], { content: 5 }],
    };
    for (const [key, wrong] of Object.entries(kinds)) {
      const answers = {
        ...cut,
        ...Object.fromEntries(
          wrong.map((value) => [
            JSON.stringify(value),
            () => ({ status: 0, stdout: included(200, JSON.stringify(value)), stderr: "" }),
          ]),
        ),
      };
      for (const [what, given] of Object.entries(answers)) {
        const hub = github((state) => {
          if (key === `GET ${FILE}`) state.actions.sha_pinning_required = false;
          state.answers[key] = given;
        });
        assert.throws(
          () => hub.call(true),
          (error) =>
            error.message === `${key}: the answer could not be read (HTTP 200)` &&
            !(error instanceof TypeError),
          `${key}, ${what}`,
        );
        assert.deepEqual(hub.written(), [], `${key}, ${what}`);
      }
    }
  });
});

describe("applying the file", () => {
  for (const [field, malformed] of [
    ["required_pull_request_reviews", { ...REVIEW_RULE, dismiss_stale_reviews: "false" }],
    ["restrictions", { ...PUSH_RESTRICTIONS, users: "x" }],
  ]) {
    test(`refuses to plan a write for changed strict checks with malformed ${field} fields`, () => {
      const hub = github((state) => {
        state.protection.required_status_checks.strict = true;
        state.protection[field] = malformed;
      });
      assert.throws(() => hub.call(true), {
        message: `GET ${PROTECTION}: the answer could not be read (HTTP 200)`,
      });
      assert.deepEqual(hub.written(), []);
    });
  }

  test("requires the known fields of enabled review and push settings to have their REST types", () => {
    const invalid = [
      ["required_pull_request_reviews", { dismiss_stale_reviews: false }],
      ["required_pull_request_reviews", { ...REVIEW_RULE, required_approving_review_count: 0.5 }],
      ["required_pull_request_reviews", { ...REVIEW_RULE, require_last_push_approval: "true" }],
      ["required_pull_request_reviews", { ...REVIEW_RULE, dismissal_restrictions: { url: 0 } }],
      ["required_pull_request_reviews", { ...REVIEW_RULE, bypass_pull_request_allowances: [] }],
      ["restrictions", { ...PUSH_RESTRICTIONS, apps_url: undefined }],
      ["restrictions", { ...PUSH_RESTRICTIONS, teams: ["a-team"] }],
    ];
    for (const [field, malformed] of invalid) {
      const hub = github((state) => {
        state.protection.required_status_checks.strict = true;
        state.protection[field] = malformed;
      });
      assert.throws(
        () => hub.call(true),
        { message: `GET ${PROTECTION}: the answer could not be read (HTTP 200)` },
        JSON.stringify(malformed),
      );
      assert.deepEqual(hub.written(), []);
    }
  });

  test("patches only the strict checks while review and push settings are off", () => {
    const hub = github((state) => {
      state.protection.required_status_checks.strict = true;
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

  test("reads enabled review and push settings with extra fields from GitHub", () => {
    const hub = github((state) => {
      state.protection.required_pull_request_reviews = {
        ...REVIEW_RULE,
        required_approving_review_count: 1,
        require_last_push_approval: true,
        dismissal_restrictions: { users: [], url: PROTECTION_URL },
        bypass_pull_request_allowances: { apps: [] },
        enabled: "a future field",
      };
      state.protection.restrictions = { ...PUSH_RESTRICTIONS, enabled: false };
    });
    assert.equal(hub.call(), 1);
    const output = hub.output.join("\n");
    assert.match(output, /protection\.required_pull_request_reviews: GitHub has \{/u);
    assert.match(output, /protection\.restrictions: GitHub has \{/u);
    assert.deepEqual(hub.written(), []);
  });

  test("sends no write when REST says the branch is unprotected and GraphQL shows a rule", () => {
    const hub = github((state) => {
      state.protection = null;
      state.answers["POST graphql"] = partly((repository) => {
        repository.ref.branchProtectionRule = ruleOf(state.classic);
      });
    });
    assert.throws(
      () => hub.call(true),
      /could not be read: REST returned HTTP 404 \(Branch not protected\), but GraphQL returned branchProtectionRule: an object/u,
    );
    assert.deepEqual(hub.written(), []);
  });

  test("stops after the Actions write when REST shows protection and GraphQL shows no rule", () => {
    const hub = github((state) => {
      state.actions.sha_pinning_required = false;
      state.answers[`PUT ${ACTIONS}`] = (now, write) => {
        now.answers["POST graphql"] = partly((repository) => {
          repository.ref.branchProtectionRule = null;
        });
        return write();
      };
    });
    assert.throws(
      () => hub.call(true),
      /could not be read: REST returned a protection object, but GraphQL returned branchProtectionRule: null/u,
    );
    assert.deepEqual(hub.written(), [{ method: "PUT", address: ACTIONS, body: wanted.actions }]);
    assert.match(hub.output.at(-1), /^Sent actions: GitHub could not be read after it/u);
  });

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
    assert.match(
      hub.output.join("\n"),
      /Sent, and GitHub showed each as the file says after its request: actions, branch protection\./u,
    );
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

  test("says what was sent and shown when a later write is refused, from the state read after each write", () => {
    const hub = github((state) => {
      state.protection = null;
      state.actions.sha_pinning_required = false;
      state.fails[`PUT ${PROTECTION}`] = ["Validation Failed", 422];
    });
    assert.equal(hub.call(true), 1);
    const output = hub.output.join("\n");
    assert.match(
      output,
      /Not as the file says after it was sent: branch protection\. Differences gone since the read before it: none; left: protection\. The answer was PUT .*: Validation Failed \(HTTP 422\)\./u,
    );
    assert.match(
      output,
      /Sent before it, and GitHub showed each as the file says after its request: actions\./u,
    );
    assert.match(output, /GitHub still differs from the file:\n- protection: GitHub has null/u);
    assert.doesNotMatch(output.split("GitHub still differs from the file:")[1], /actions\./u);
    const reads = [`GET ${ACTIONS}`, `GET ${PROTECTION}`, `GET ${RULES}`, "POST graphql"];
    assert.deepEqual(
      hub.asked.map(({ method, address }) => `${method} ${address}`),
      [
        `GET ${REPOSITORY}`,
        ...reads,
        `GET ${FILE}`,
        ...reads,
        `PUT ${ACTIONS}`,
        ...reads,
        `PUT ${PROTECTION}`,
        ...reads,
      ],
    );
  });

  test("stops at a refused first write and says nothing was sent before it", () => {
    const hub = github((state) => {
      state.protection = null;
      state.actions.sha_pinning_required = false;
      state.fails[`PUT ${ACTIONS}`] = ["Must have admin rights", 403];
    });
    assert.equal(hub.call(true), 1);
    assert.equal(hub.written().length, 1);
    assert.match(
      hub.output.join("\n"),
      /Not as the file says after it was sent: actions\. Differences gone since the read before it: none; left: actions\.sha_pinning_required\. The answer was PUT .*: Must have admin rights \(HTTP 403\)\.\nNothing was sent before it\./u,
    );
  });

  test("does not take a write answered by the 200 of the GET a redirect made of it for written", () => {
    const hub = github((state) => {
      state.protection = null;
      state.actions.sha_pinning_required = false;
      state.answers[`PUT ${ACTIONS}`] = (now) => ({
        status: 0,
        stdout: included(200, JSON.stringify(now.actions)),
        stderr: "",
      });
    });
    assert.equal(hub.call(true), 1);
    assert.deepEqual(
      hub.written().map(({ method, address }) => `${method} ${address}`),
      [`PUT ${ACTIONS}`],
    );
    const output = hub.output.join("\n");
    assert.match(
      output,
      /Not as the file says after it was sent: actions\. Differences gone since the read before it: none; left: actions\.sha_pinning_required\. The answer was PUT .*: HTTP 200\.\nNothing was sent before it\./u,
    );
    assert.doesNotMatch(output, /^Sent,/mu);
  });

  test("says a write GitHub answered with success is not as the file says when GitHub still shows the old state", () => {
    const hub = github((state) => {
      state.protection.required_signatures.enabled = true;
      state.answers[`DELETE ${PROTECTION}/required_signatures`] = empty;
    });
    assert.equal(hub.call(true), 1);
    assert.match(
      hub.output.join("\n"),
      /Not as the file says after it was sent: required signatures\. Differences gone since the read before it: none; left: required_signatures\. The answer was DELETE .*: HTTP 204\./u,
    );
    assert.match(hub.output.at(-1), /- required_signatures: GitHub has true/u);
  });

  test("takes a write that GitHub shows as the file says for done whatever its answer, and goes on", () => {
    const lost = {
      "a server error": () => ({
        status: 1,
        stdout: included(502, JSON.stringify({ message: "Server Error" })),
        stderr: "gh: Server Error (HTTP 502)\n",
      }),
      "no answer": () => ({
        status: 1,
        stdout: "",
        stderr: 'Put "https://api.github.com/x": read tcp: connection reset by peer\n',
      }),
      "a gh that timed out": () => {
        throw Object.assign(new Error("spawnSync gh ETIMEDOUT"), { code: "ETIMEDOUT" });
      },
      "a body cut short": () => ({ status: 0, stdout: included(200, "{"), stderr: "" }),
    };
    for (const [what, given] of Object.entries(lost)) {
      const hub = github((state) => {
        state.protection = null;
        state.actions.sha_pinning_required = false;
        state.answers[`PUT ${ACTIONS}`] = (_, write) => {
          write();
          return given();
        };
      });
      assert.equal(hub.call(true), 0, what);
      assert.deepEqual(
        hub.written().map(({ method, address }) => `${method} ${address}`),
        [`PUT ${ACTIONS}`, `PUT ${PROTECTION}`],
        what,
      );
      const output = hub.output.join("\n");
      assert.doesNotMatch(output, /Not as the file says|Nothing was sent/u, what);
      if (what !== "a body cut short")
        assert.match(
          output,
          /actions: GitHub shows it as the file says, although the answer was PUT /u,
          what,
        );
      assert.match(
        output,
        /Sent, and GitHub showed each as the file says after its request: actions, branch protection\./u,
        what,
      );
      assert.match(hub.output.at(-1), /is now protected as the file says/u, what);
    }
  });

  test("says what was sent and shown and what is not known when GitHub cannot be read after a write", () => {
    const hub = github((state) => {
      state.protection = null;
      state.actions.sha_pinning_required = false;
    });
    const { state } = hub;
    state.answers[`PUT ${PROTECTION}`] = () => {
      state.unreachable.add(`GET ${ACTIONS}`);
      throw new Error("spawnSync gh ETIMEDOUT");
    };
    assert.throws(() => hub.call(true), /ENOENT/u);
    assert.deepEqual(hub.output.slice(-2), [
      "Sent before it, and GitHub showed each as the file says after its request: actions.",
      "Sent branch protection: GitHub could not be read after it, so it is not known whether " +
        `GitHub shows it as the file says (the answer was PUT ${PROTECTION}: no answer (spawnSync gh ETIMEDOUT)).`,
    ]);
  });

  test("sends no further write when GitHub cannot be read after the first of two", () => {
    const hub = github((state) => {
      state.protection = null;
      state.actions.sha_pinning_required = false;
      state.answers[`PUT ${ACTIONS}`] = (now, write) => {
        now.unreachable.add(`GET ${ACTIONS}`);
        return write();
      };
    });
    assert.throws(() => hub.call(true), /ENOENT/u);
    assert.deepEqual(
      hub.written().map(({ method, address }) => `${method} ${address}`),
      [`PUT ${ACTIONS}`],
    );
    assert.deepEqual(hub.output.slice(-2), [
      "Nothing was sent before it.",
      "Sent actions: GitHub could not be read after it, so it is not known whether " +
        `GitHub shows it as the file says (the answer was PUT ${ACTIONS}: HTTP 204).`,
    ]);
  });

  test("explains a write that is not written by the status of its answer, not by a code its message holds", () => {
    for (const address of [ACTIONS, PROTECTION]) {
      const hub = github((state) => {
        if (address === ACTIONS) state.actions.sha_pinning_required = false;
        else state.protection = null;
        state.answers[`PUT ${address}`] = () => ({
          status: 1,
          stdout: included(502, JSON.stringify({ message: "upstream failed (HTTP 422)" })),
          stderr: "gh: upstream failed (HTTP 422) (HTTP 502)\n",
        });
      });
      assert.equal(hub.call(true), 1, address);
      const output = hub.output.join("\n");
      assert.match(
        output,
        /\. The answer was PUT .*: upstream failed \(HTTP 422\) \(HTTP 502\)\.\nNothing was sent before it\./u,
        address,
      );
      assert.doesNotMatch(output, new RegExp(HEADER, "u"), address);
    }
  });

  test("explains a refused write by its status whether the body is GitHub's JSON or text", () => {
    for (const [stdout, stderr] of [
      [
        included(429, JSON.stringify({ message: "API rate limit exceeded" })),
        "gh: API rate limit exceeded (HTTP 429)\n",
      ],
      [included(429, "Too many requests\n"), "gh: HTTP 429\n"],
    ]) {
      const hub = github((state) => {
        state.actions.sha_pinning_required = false;
        state.answers[`PUT ${ACTIONS}`] = () => ({ status: 1, stdout, stderr });
      });
      assert.equal(hub.call(true), 1);
      const output = hub.output.join("\n");
      assert.match(
        output,
        /Not as the file says after it was sent: actions\. .*The answer was PUT .*\(HTTP 429\)\.\nNothing was sent before it\./u,
      );
      assert.doesNotMatch(output, new RegExp(HEADER, "u"));
    }
  });

  test("says of a write without an answer only the last line gh printed, and only so much of it", () => {
    const long = `Put "https://api.github.com/x": ${"x".repeat(1000)}`;
    for (const [stderr, said] of [
      [
        "* Request at 2026-11-25 10:00:00\n> PUT /repos/1ma-ai/1ma/actions/permissions HTTP/1.1\n" +
          "> Authorization: token gho_0123456789\n< HTTP/2.0 301 Moved Permanently\n" +
          `< Location: https://api.github.com/repositories/1\n\n  ${long}  \n\n`,
        `${long.slice(0, 300)}…`,
      ],
      ["", "gh printed nothing"],
    ]) {
      const hub = github((state) => {
        state.actions.sha_pinning_required = false;
        state.answers[`PUT ${ACTIONS}`] = () => ({ status: 1, stdout: "", stderr });
      });
      assert.equal(hub.call(true), 1);
      const output = hub.output.join("\n");
      assert.ok(
        output.includes(`The answer was PUT ${ACTIONS}: no answer (${said}).`),
        output.slice(0, 2000),
      );
      assert.doesNotMatch(output, /Authorization|Location|x{301}/u);
    }
  });

  test("does not take a list of checks for written when the protection is gone after its request, and sends nothing after it", () => {
    const hub = github((state) => {
      state.protection.required_status_checks.checks.pop();
      state.protection.required_signatures.enabled = true;
      state.answers[`PATCH ${PROTECTION}/required_status_checks`] = (now) => {
        now.protection = null;
        return {
          status: 1,
          stdout: included(404, JSON.stringify({ message: "Branch not protected" })),
          stderr: "gh: Branch not protected (HTTP 404)\n",
        };
      };
    });
    assert.equal(hub.call(true), 1);
    assert.deepEqual(
      hub.written().map(({ method, address }) => `${method} ${address}`),
      [`PATCH ${PROTECTION}/required_status_checks`],
    );
    const output = hub.output.join("\n");
    assert.match(
      output,
      /Not as the file says after it was sent: required checks\. Differences gone since the read before it: none; left: protection\. The answer was PATCH .*: Branch not protected \(HTTP 404\)\.\nNothing was sent before it\./u,
    );
    assert.match(output, /GitHub still differs from the file:\n- protection: GitHub has null/u);
  });

  test("does not take switched-off signatures for written when the protection is gone after the request", () => {
    const hub = github((state) => {
      state.protection.required_signatures.enabled = true;
      state.answers[`DELETE ${PROTECTION}/required_signatures`] = (now) => {
        now.protection = null;
        return empty();
      };
    });
    assert.equal(hub.call(true), 1);
    assert.match(
      hub.output.join("\n"),
      /Not as the file says after it was sent: required signatures\. Differences gone since the read before it: required_signatures; left: protection\./u,
    );
  });

  test("does not send a write the state read before it already shows as the file says", () => {
    const hub = github((state) => {
      state.actions.sha_pinning_required = false;
      state.protection.required_status_checks.checks.pop();
      state.answers[`PUT ${ACTIONS}`] = (now, write) => {
        now.protection.required_status_checks.checks = structuredClone(
          wanted.protection.required_status_checks.checks,
        );
        return write();
      };
    });
    assert.equal(hub.call(true), 0);
    assert.deepEqual(
      hub.written().map(({ method, address }) => `${method} ${address}`),
      [`PUT ${ACTIONS}`],
    );
    const output = hub.output.join("\n");
    assert.match(
      output,
      /\nSent, and GitHub showed each as the file says after its request: actions\.\n/u,
    );
    assert.doesNotMatch(output.split("\n").slice(3).join("\n"), /required checks/u);
  });

  test("computes the first write from the state read after the file on main is checked", () => {
    const hub = github((state) => {
      state.actions.sha_pinning_required = false;
      state.answers[`GET ${FILE}`] = (now, read) => {
        now.actions.sha_pinning_required = true;
        return read();
      };
    });
    assert.equal(hub.call(true), 0);
    assert.deepEqual(hub.written(), []);
    assert.deepEqual(hub.output.slice(-2), [
      "Nothing was sent: GitHub shows every part this script writes as the file says.",
      "main of 1ma-ai/1ma is now protected as the file says",
    ]);
  });

  test("sends each part once, even when a later read shows it differing again", () => {
    const hub = github((state) => {
      state.actions.sha_pinning_required = false;
      state.protection.required_status_checks.checks.pop();
      state.answers[`PATCH ${PROTECTION}/required_status_checks`] = (now, write) => {
        now.actions.sha_pinning_required = false;
        return write();
      };
    });
    assert.equal(hub.call(true), 1);
    assert.deepEqual(
      hub.written().map(({ method, address }) => `${method} ${address}`),
      [`PUT ${ACTIONS}`, `PATCH ${PROTECTION}/required_status_checks`],
    );
    assert.deepEqual(hub.output.slice(-3), [
      "Sent, and GitHub showed each as the file says after its request: actions, required checks.",
      "GitHub still differs from the file:",
      "- actions.sha_pinning_required: GitHub has false, the file says true",
    ]);
  });

  test("names what a refused write changed and what it left", () => {
    const hub = github((state) => {
      state.actions.enabled = false;
      state.answers[`PUT ${ACTIONS}`] = (now) => {
        now.actions.enabled = true;
        now.actions.sha_pinning_required = false;
        return empty();
      };
    });
    assert.equal(hub.call(true), 1);
    const output = hub.output.join("\n");
    assert.match(
      output,
      /Not as the file says after it was sent: actions\. Differences gone since the read before it: actions\.enabled; left: actions\.sha_pinning_required\. The answer was PUT .*: HTTP 204\.\nNothing was sent before it\./u,
    );
    assert.doesNotMatch(output, /Nothing was written/u);
  });

  test("writes the Actions settings of a repository with Actions off, and decides by the read after it", () => {
    const hub = github((state) => {
      state.actions = { enabled: false };
    });
    assert.equal(hub.call(true), 0);
    assert.deepEqual(hub.written(), [{ method: "PUT", address: ACTIONS, body: wanted.actions }]);
    const half = github((state) => {
      state.actions = { enabled: false };
      state.answers[`PUT ${ACTIONS}`] = (now) => {
        now.actions = { enabled: true };
        return empty();
      };
    });
    assert.equal(half.call(true), 1);
    assert.match(
      half.output.join("\n"),
      /Not as the file says after it was sent: actions\. Differences gone since the read before it: actions\.enabled; left: actions\.allowed_actions, actions\.sha_pinning_required\./u,
    );
  });

  test("cannot change what only the classic rules hold, and says so", () => {
    const outside = {
      required_deployment_environments: (state) => {
        state.classic.requiresDeployments = true;
        state.classic.requiredDeploymentEnvironments = ["production"];
      },
      bypass_force_push_allowances: (state) => {
        state.classic.bypass = [{ kind: "User", login: "somebody" }];
      },
      merge_queue: (state) => {
        state.queue = { id: "MQ_1" };
      },
    };
    for (const [name, change] of Object.entries(outside)) {
      const hub = github(change);
      assert.equal(hub.call(true), 1, name);
      assert.deepEqual(hub.written(), [], name);
      assert.match(hub.output.at(-2), new RegExp(`^- ${name}: `, "u"), name);
      assert.match(
        hub.output.at(-1),
        /classic branch protection rules; this script does not change them/u,
        name,
      );
    }
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

describe("running gh", () => {
  test("ends a gh that does not end in time, even one that ignores SIGTERM", () => {
    const gh = ghRunner({ program: process.execPath, timeout: 2_000 });
    assert.equal(gh(["-e", "process.stdout.write('done')"]).stdout, "done");
    const started = Date.now();
    assert.throws(
      () => gh(["-e", "process.on('SIGTERM', () => {}); setTimeout(() => {}, 30_000);"]),
      { code: "ETIMEDOUT" },
    );
    assert.ok(Date.now() - started < 15_000, `held for ${Date.now() - started} ms`);
  });

  test("starts gh without the settings that make it print its headers", () => {
    const kept = { ...process.env };
    Object.assign(process.env, { GH_DEBUG: "api", DEBUG: "1", A_SETTING_GH_KEEPS: "kept" });
    try {
      const gh = ghRunner({ program: process.execPath });
      const env = JSON.parse(
        gh(["-e", "process.stdout.write(JSON.stringify(process.env))"]).stdout,
      );
      assert.equal(env.GH_DEBUG, undefined);
      assert.equal(env.DEBUG, undefined);
      assert.equal(env.A_SETTING_GH_KEEPS, "kept");
    } finally {
      for (const name of ["GH_DEBUG", "DEBUG", "A_SETTING_GH_KEEPS"])
        if (Object.hasOwn(kept, name)) process.env[name] = kept[name];
        else delete process.env[name];
    }
  });
});
