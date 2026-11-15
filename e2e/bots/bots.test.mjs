import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { waitFor } from "../lib/servers.mjs";
import {
  BOTS,
  completedOf,
  diagnose,
  exchangeOf,
  createBot,
  fleet,
  projects,
  regularThread,
  rename,
  rpc,
  say,
  server,
  setUp,
  startConversation,
  stubCall,
  stubRecords,
  thread,
  waitStatus,
  waitTurns,
} from "./harness.mjs";
import {
  expandBot,
  fontOf,
  launch,
  openApp,
  screenshot,
  groupsOf,
  selectSidebar,
  threadLink,
  waitDrawn,
} from "./sidebar.mjs";

const SECOND = 1000;
async function counts(page, places) {
  const entries = await Promise.all(
    Object.entries(places).map(async ([name, [scope, threadId]]) => [
      name,
      await page.locator(`${scope} a[data-sidebar-thread-id="${threadId}"]`).count(),
    ]),
  );
  return Object.fromEntries(entries);
}
const letterOutputs = (since) =>
  stubRecords()
    .filter((entry) => entry.kind === "tool" && entry.name === "bot_message")
    .slice(since);
const lettersToAlice = (since) =>
  letterOutputs(since).filter((entry) => entry.output?.includes("for Alice"));

before(setUp);
after(() => fleet.stopAll());

describe("1ma-bots on a real server", () => {
  it("starts a conversation with the bot's identity, instructions and capabilities", async () => {
    const marker = "E2E-INSTRUCTIONS-7f3a9c";
    const bot = await createBot("Dev Bot", {
      role: "Developer",
      capabilities: ["dev"],
      instructions: `Always answer in haiku. ${marker}`,
    });
    const threadId = await startConversation(bot, "[stub:reply seam-first-turn]");
    await waitTurns(threadId, 1);

    const row = await thread(threadId);
    assert.equal(row.originPluginId, BOTS);
    assert.deepEqual(await rpc("bots.v1.forThread", { threadId }), {
      botId: bot.id,
      capabilities: ["dev"],
    });
    const first = stubRecords().find(
      (entry) => entry.kind === "prompt" && entry.text.includes("seam-first-turn"),
    );
    assert.ok(first, "the stub agent received the first turn");
    assert.match(first.text, /<system_instructions>/);
    assert.ok(first.text.includes(marker), "the bot's instructions reached the agent");
    assert.ok(first.text.includes("Dev Bot"), "the bot's name reached the agent");
    const tools = stubRecords().find((entry) => entry.kind === "tools" && entry.tools?.length);
    assert.ok(
      tools?.tools.includes("bot_read"),
      `the bot's tools reached the agent: ${JSON.stringify(tools)}`,
    );
  });

  it("refuses to mark a conversation done while a question waits, and allows it after the answer", async () => {
    const bot = await createBot("Asker", { capabilities: ["dev"] });
    const threadId = await startConversation(
      bot,
      "[stub:ask Run the build]",
      projects.alpha,
      { permissionMode: "accept-edits" },
    );
    const card = await waitFor("the pending question", 60 * SECOND, async () => {
      const cards = await server.api("GET", `/threads/${threadId}/interactions`);
      return cards.find((candidate) => candidate.status === "pending") ?? null;
    }).catch(async (error) => {
      const cards = await server.api("GET", `/threads/${threadId}/interactions`);
      throw new Error(`${error.message}\n${diagnose({ cards, thread: await thread(threadId) })}`);
    });
    await assert.rejects(
      rpc("bots.v1.setCompleted", { threadId, completed: true }),
      /waiting for the owner/,
    );
    assert.equal(await completedOf(bot.id, threadId), false);

    await server.api("POST", `/threads/${threadId}/interactions/${card.id}/resolve`, {
      decision: "allow_once",
      grantedPermissions: null,
    });
    await waitTurns(threadId, 1);
    await waitStatus(threadId, "idle");
    await rpc("bots.v1.setCompleted", { threadId, completed: true });
    assert.equal(await completedOf(bot.id, threadId), true);
  });

  it("reopens a done conversation when the owner presses Send now on a queued message", async () => {
    const bot = await createBot("Sender", { capabilities: ["dev"] });
    const threadId = await startConversation(bot, "[stub:reply first]");
    await waitTurns(threadId, 1);
    await waitStatus(threadId, "idle");

    await say(threadId, "[stub:wait 45]");
    await waitStatus(threadId, "active");
    await rpc("bots.v1.setCompleted", { threadId, completed: true });
    assert.equal(await completedOf(bot.id, threadId), true);

    await server.api("POST", `/threads/${threadId}/queued-messages`, {
      input: [{ type: "text", text: "[stub:reply queued-by-owner]", mentions: [] }],
    });
    const [queued] = await server.api("GET", `/threads/${threadId}/queued-messages`);
    assert.ok(queued, "the message waits in the queue of the busy conversation");
    assert.equal(await completedOf(bot.id, threadId), true, "queueing alone changes nothing");

    await server.api("POST", `/threads/${threadId}/queued-messages/${queued.id}/send`, {
      mode: "auto",
    });
    await waitFor("the conversation to reopen", 60 * SECOND, async () => {
      return (await completedOf(bot.id, threadId)) === false;
    });
    await waitFor("the queued message to reach the agent", 120 * SECOND, async () =>
      stubRecords().some(
        (entry) => entry.kind === "prompt" && entry.text.includes("queued-by-owner"),
      ),
    );
  });

  it(
    "keeps a letter queued in a busy conversation out of its exchange until it is dispatched",
    {
      todo: "known defect in 1ma-bots: the message.dispatch hook takes the letter into the exchange when the dispatch attempt is queued behind the running turn",
    },
    async () => {
    const alice = await createBot("Alice", { capabilities: ["dev"] });
    const bruno = await createBot("Bruno", { capabilities: ["dev"] });
    const aliceThread = await startConversation(alice, "[stub:reply ready-a]");
    const brunoThread = await startConversation(bruno, "[stub:reply ready-b]");
    await Promise.all([waitTurns(aliceThread, 1), waitTurns(brunoThread, 1)]);
    await Promise.all([waitStatus(aliceThread, "idle"), waitStatus(brunoThread, "idle")]);

    const known = letterOutputs(0).length;
    const toAlice = (text) => ({ to: alice.id, threadId: aliceThread, text });
    // Bruno's busy turn writes to Alice after Alice's letter is already queued
    // behind it; the letter text itself makes Bruno write to Alice once more
    // when it is finally dispatched.
    const second = stubCall("bot_message", toAlice("second-from-bruno"));
    await say(
      brunoThread,
      `[stub:wait 45] ${stubCall("bot_message", toAlice("first-from-bruno"))}`,
    );
    await waitStatus(brunoThread, "active");
    const own = exchangeOf(brunoThread);
    assert.ok(own.chain, "Bruno's own message started an exchange");
    assert.equal(own.chain.letters, 0);
    await say(
      aliceThread,
      stubCall("bot_message", { to: bruno.id, threadId: brunoThread, text: second }),
    );

    await waitFor("Alice's letter to be queued", 60 * SECOND, async () => {
      const queued = await server.api("GET", `/threads/${brunoThread}/queued-messages`);
      return queued.length === 1;
    });
    const waiting = exchangeOf(brunoThread);
    assert.deepEqual(
      waiting,
      { chain: own.chain, waiting: 1 },
      `a queued letter leaves Bruno's exchange alone; the queue: ${JSON.stringify(
        (await server.api("GET", `/threads/${brunoThread}/queued-messages`)).map((row) => [
          row.state,
          row.waitingOn,
        ]),
      )}; Alice's exchange: ${JSON.stringify(exchangeOf(aliceThread))}`,
    );
    const alicesExchange = exchangeOf(aliceThread).chain;
    assert.ok(alicesExchange && alicesExchange.id !== own.chain.id);
    const observed = {
      queued: await server.api("GET", `/threads/${brunoThread}/queued-messages`),
      status: (await thread(brunoThread)).status,
    };
    const mine = await waitFor("Bruno's own letter", 120 * SECOND, async () =>
      lettersToAlice(known).find(Boolean),
    );
    assert.match(
      mine.output,
      /^Letter 1\//,
      `Bruno's turn is still in his own exchange while Alice's letter waits in the queue\n${diagnose(observed)}`,
    );

    const again = await waitFor(
      "the dispatched letter to make Bruno write again",
      180 * SECOND,
      async () => (lettersToAlice(known).length >= 2 ? lettersToAlice(known) : null),
    );
    assert.match(
      again[1].output,
      /^Letter 2\//,
      "after dispatch Bruno's next letter continues Alice's exchange",
    );
    assert.equal(exchangeOf(brunoThread).chain?.id, alicesExchange.id);
    },
  );
});

describe("1ma-sidebar with the bots block", () => {
  const fixture = {};
  let browser;

  before(async () => {
    // Earlier scenarios left bots behind; the layout checks need their own.
    const { bots } = await rpc("bots.v1.list", {});
    await Promise.all(bots.map((bot) => rpc("bots.v1.remove", { botId: bot.id })));
    fixture.visible = await createBot("Visual Bot", { role: "Researcher", capabilities: ["dev"] });
    fixture.hidden = await createBot("Hidden Bot", { role: "Sleeper" });
    fixture.plain = regularThread(projects.alpha, "Regular thread");
    fixture.v1 = await startConversation(fixture.visible, "[stub:reply v1]", projects.alpha);
    fixture.v2 = await startConversation(fixture.visible, "[stub:reply v2]", projects.alpha);
    fixture.h1 = await startConversation(fixture.hidden, "[stub:reply h1]", projects.beta);
    await rename(fixture.v1, "Bot conversation one");
    await rename(fixture.v2, "Bot conversation two");
    await rename(fixture.h1, "Hidden bot conversation");
    await Promise.all(
      [fixture.plain, fixture.v1, fixture.v2, fixture.h1].map((id) => waitTurns(id, 1)),
    );
    const detail = await rpc("bots.v1.get", { botId: fixture.hidden.id });
    await rpc("bots.v1.update", {
      botId: fixture.hidden.id,
      expectedRevision: detail.revision,
      hidden: true,
    });
    assert.deepEqual(await selectSidebar(), {
      provider: "1ma-sidebar/thread-list",
      mode: "project",
    });
    browser = await launch();
  });

  after(async () => {
    await browser?.close();
  });

  for (const theme of ["light", "dark"]) {
    it(`shows the bots above the projects in the ${theme} theme`, async () => {
      const { context, page, problems } = await openApp(browser, theme);
      try {
        await waitDrawn(page, threadLink(page, fixture.plain), "plain-thread");
        await expandBot(page, "Visual Bot");
        await threadLink(page, fixture.v1).waitFor({ timeout: 30 * SECOND });
        await screenshot(page, `sidebar-${theme}`);

        assert.equal(
          await page.evaluate(() => document.documentElement.classList.contains("dark")),
          theme === "dark",
          "the theme the screenshot shows",
        );

        const layout = await groupsOf(
          page,
          ["Bots", "Alpha", "Beta"],
          [fixture.v1, fixture.v2, fixture.plain, fixture.h1],
        );
        assert.deepEqual(layout.order, ["Bots", "Alpha", "Beta"], "the bots block is on top");
        assert.deepEqual(layout.groupOf, {
          [fixture.v1]: "Bots",
          [fixture.v2]: "Bots",
          [fixture.plain]: "Alpha",
          [fixture.h1]: "Beta",
        });
        const botScope = `[data-bot-id="${fixture.visible.id}"]`;
        assert.deepEqual(
          await counts(page, {
            v1InBot: [botScope, fixture.v1],
            v2InBot: [botScope, fixture.v2],
            v1Drawn: ["body", fixture.v1],
            v2Drawn: ["body", fixture.v2],
          }),
          { v1InBot: 1, v2InBot: 1, v1Drawn: 1, v2Drawn: 1 },
        );
        assert.equal(
          await page.getByText("Hidden Bot", { exact: true }).count(),
          0,
          "the hidden bot is absent",
        );

        const botName = page.locator(`[data-bot-id="${fixture.visible.id}"] span.font-medium`, {
          hasText: "Visual Bot",
        });
        const rowTitle = page.locator(".bb-thread-title", { hasText: "Regular thread" });
        const [nameFont, titleFont] = await Promise.all([fontOf(botName), fontOf(rowTitle)]);
        assert.ok(nameFont.length > 0);
        assert.equal(nameFont, titleFont, "a bot name uses the font of a thread row title");
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });
  }

  it("draws no block and keeps every conversation in its project when 1ma-bots is disabled", async () => {
    server.bb(["plugin", "disable", BOTS]);
    const { context, page } = await openApp(browser, "light");
    try {
      await waitDrawn(page, threadLink(page, fixture.plain), "plain-thread");
      await Promise.all(
        [fixture.v1, fixture.v2, fixture.h1].map((id) =>
          threadLink(page, id).waitFor({ timeout: 30 * SECOND }),
        ),
      );
      const layout = await groupsOf(
        page,
        ["Alpha", "Beta"],
        [fixture.v1, fixture.v2, fixture.plain, fixture.h1],
      );
      assert.deepEqual(layout.groupOf, {
        [fixture.v1]: "Alpha",
        [fixture.v2]: "Alpha",
        [fixture.plain]: "Alpha",
        [fixture.h1]: "Beta",
      });
      await screenshot(page, "sidebar-bots-disabled");
      assert.equal(await page.locator('[data-sidebar-section-id="1ma-bots"]').count(), 0);
      assert.equal(await page.locator("[data-bot-id]").count(), 0);
    } finally {
      await context.close();
      server.bb(["plugin", "enable", BOTS]);
    }
  });
});
