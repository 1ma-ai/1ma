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
    classic: [
      {
        pattern: "main",
        requiresDeployments: false,
        requiredDeploymentEnvironments: [],
        bypass: [],
        refs: ["main", "maintenance"],
      },
    ],
    queue: null,
    file: text,
    fails: {},
    answers: {},
    unreachable: new Set(),
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
    if (method === "POST" && address === "graphql") {
      // GitHub narrows the refs by the query as a part of their name.
      const { branch } = body.variables;
      const nodes = state.classic.map(({ refs, bypass = [], ...rule }) => ({
        ...rule,
        bypassForcePushAllowances: {
          pageInfo: { hasNextPage: false },
          nodes: bypass.map((actor) => ({ actor })),
        },
        matchingRefs: {
          pageInfo: { hasNextPage: false },
          nodes: refs.filter((ref) => ref.includes(branch)).map((name) => ({ name })),
        },
      }));
      return answer({
        data: {
          repository: {
            mergeQueue: state.queue,
            branchProtectionRules: { pageInfo: { hasNextPage: false }, nodes },
          },
        },
      });
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
  const written = () =>
    asked.filter((entry) => entry.method !== "GET" && entry.address !== "graphql");
  return { state, asked, output, call, written };
}

// GitHub's answer to the GraphQL question with one part of it changed.
const partly = (change) => (_, read) => {
  const answer = JSON.parse(read().stdout);
  change(answer.data.repository);
  return { status: 0, stdout: JSON.stringify(answer), stderr: "" };
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
    assert.ok(hub.asked.length >= 4);
    for (const { address, body } of hub.asked)
      if (address === "graphql")
        assert.deepEqual(body.variables, { owner: "1ma-ai", name: "1ma", branch: "main" });
      else assert.ok(address.startsWith(`${REPOSITORY}/`), address);
  });

  test("names a deployment a classic rule for the branch requires, which the REST answer leaves out", () => {
    const hub = github((state) => {
      state.classic[0].requiresDeployments = true;
      state.classic[0].requiredDeploymentEnvironments = ["production"];
    });
    assert.equal(hub.call(), 1);
    assert.deepEqual(hub.output.slice(1), [
      '- required_deployment_environments: GitHub has ["production"], the file says []',
    ]);
  });

  test("takes only the classic rules whose pattern GitHub matches to the branch", () => {
    const hub = github((state) => {
      state.classic.push(
        {
          pattern: "maint*",
          requiresDeployments: true,
          requiredDeploymentEnvironments: ["staging"],
          bypass: [{ kind: "User", login: "somebody" }],
          refs: ["maintenance"],
        },
        {
          pattern: "*",
          requiresDeployments: true,
          requiredDeploymentEnvironments: ["production"],
          refs: ["main", "maintenance", "release"],
        },
      );
    });
    assert.equal(hub.call(), 1);
    assert.deepEqual(hub.output.slice(1), [
      '- required_deployment_environments: GitHub has ["production"], the file says []',
    ]);
  });

  test("names who may force push past the protection, which the REST answer leaves out", () => {
    const hub = github((state) => {
      state.classic[0].bypass = [
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
        repository.branchProtectionRules.nodes[0].bypassForcePushAllowances.pageInfo.hasNextPage = true;
      }),
      partly((repository) => {
        delete repository.branchProtectionRules.nodes[0].bypassForcePushAllowances;
      }),
      () => ({ status: 0, stdout: JSON.stringify({ data: { repository: null } }), stderr: "" }),
      () => ({
        status: 0,
        stdout: JSON.stringify({
          data: {
            repository: {
              branchProtectionRules: { pageInfo: { hasNextPage: true }, nodes: [] },
            },
          },
        }),
        stderr: "",
      }),
      () => ({
        status: 1,
        stdout: JSON.stringify({ errors: [{ message: "Something went wrong" }] }),
        stderr: "gh: Something went wrong\n",
      }),
    ];
    for (const given of broken) {
      const hub = github((state) => {
        state.answers["POST graphql"] = given;
      });
      assert.throws(() => hub.call(), /branch protection rules|Something went wrong/u);
      assert.deepEqual(hub.output, []);
    }
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
        "POST graphql",
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

  test("after a write whose answer broke off, reads GitHub again and says what is there", () => {
    const hub = github((state) => {
      state.protection = null;
      state.actions.sha_pinning_required = false;
      state.answers[`PUT ${PROTECTION}`] = (_, write) => ({ ...write(), stdout: "{" });
    });
    assert.equal(hub.call(true), 0);
    const output = hub.output.join("\n");
    assert.match(output, /Written: actions, branch protection\./u);
    assert.match(hub.output.at(-1), /is now protected as the file says/u);
    assert.equal(hub.asked.at(-1).address, "graphql");
  });

  test("does not say nothing was written when the first write's answer did not arrive", () => {
    const hub = github((state) => {
      state.protection = null;
      state.actions.sha_pinning_required = false;
      state.answers[`PUT ${REPOSITORY}/actions/permissions`] = (_, write) => {
        write();
        return {
          status: 1,
          stdout: "",
          stderr: 'Put "https://api.github.com/x": read tcp: connection reset by peer\n',
        };
      };
    });
    assert.equal(hub.call(true), 1);
    const output = hub.output.join("\n");
    assert.doesNotMatch(output, /Nothing was written/u);
    assert.match(
      output,
      /Writing actions: .*connection reset by peer.*unknown whether it was written/u,
    );
    assert.equal(hub.written().length, 1);
    const after = output.split("GitHub still differs from the file:")[1];
    assert.match(after, /- protection: GitHub has null/u);
    assert.doesNotMatch(after, /actions\./u);
  });

  test("says what was written and what is unknown before it fails to read GitHub again", () => {
    const hub = github((state) => {
      state.protection = null;
      state.actions.sha_pinning_required = false;
    });
    const { state } = hub;
    state.answers[`PUT ${PROTECTION}`] = () => {
      state.unreachable.add(`GET ${REPOSITORY}/actions/permissions`);
      throw new Error("spawnSync gh ETIMEDOUT");
    };
    assert.throws(() => hub.call(true), /ENOENT/u);
    assert.deepEqual(hub.output.slice(-2), [
      "Writing branch protection: no answer says whether it succeeded (spawnSync gh ETIMEDOUT), " +
        "so it is unknown whether it was written.",
      "Already written: actions.",
    ]);
  });

  test("does not say nothing was written when GitHub answers the first write with a server error", () => {
    const hub = github((state) => {
      state.protection = null;
      state.actions.sha_pinning_required = false;
      state.answers[`PUT ${REPOSITORY}/actions/permissions`] = (_, write) => {
        write();
        return {
          status: 1,
          stdout: JSON.stringify({ message: "Server Error" }),
          stderr: "gh: Server Error (HTTP 502)\n",
        };
      };
    });
    assert.equal(hub.call(true), 1);
    const output = hub.output.join("\n");
    assert.doesNotMatch(output, /Nothing was written|failed/u);
    assert.match(output, /Writing actions: .*Server Error.*unknown whether it was written/u);
    assert.equal(hub.written().length, 1);
    const after = output.split("GitHub still differs from the file:")[1];
    assert.match(after, /- protection: GitHub has null/u);
    assert.doesNotMatch(after, /actions\./u);
  });

  test("cannot change what only the classic rules hold, and says so", () => {
    const outside = {
      required_deployment_environments: (state) => {
        state.classic[0].requiresDeployments = true;
        state.classic[0].requiredDeploymentEnvironments = ["production"];
      },
      bypass_force_push_allowances: (state) => {
        state.classic[0].bypass = [{ kind: "User", login: "somebody" }];
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
