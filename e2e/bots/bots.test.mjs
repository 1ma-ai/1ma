import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { waitFor } from "../lib/servers.mjs";
import {
  BOTS,
  screenshotDir,
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
  signal,
  startConversation,
  stubCall,
  stubRecords,
  thread,
  waitNotice,
  waitStatus,
  waitTurns,
} from "./harness.mjs";
import {
  expandBot,
  fontOf,
  gapAbove,
  iconOf,
  launch,
  parentRowGeometry,
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
    const threadId = await startConversation(bot, "[stub:ask Run the build]", projects.alpha, {
      permissionMode: "accept-edits",
    });
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

  it("keeps a conversation done when bb tells it about its new sub-thread", async () => {
    const bot = await createBot("Parent Bot");
    const ids = [];
    for (const name of ["parent", "child"]) {
      const id = await startConversation(bot, `[stub:reply ${name}]`);
      ids.push(id);
      await waitTurns(id, 1);
      await waitStatus(id, "idle");
    }
    const [parent, child] = ids;
    await rpc("bots.v1.setCompleted", { threadId: parent, completed: true });
    await server.api("PATCH", `/threads/${child}`, { parentThreadId: parent });
    await waitNotice(parent, "ownership-assigned", child);
    await waitStatus(parent, "idle");
    assert.equal(await completedOf(bot.id, parent), true);

    await say(parent, "[stub:reply again]");
    await waitFor(
      "the owner's message brings it back",
      60 * SECOND,
      async () => (await completedOf(bot.id, parent)) === false,
    );
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
    // 1ma-bots clears done once the provider took the message and the
    // conversation settles, after the 45-second turn.
    await waitFor("the conversation to reopen", 180 * SECOND, async () => {
      return (await completedOf(bot.id, threadId)) === false;
    });
    await waitFor("the queued message to reach the agent", 120 * SECOND, async () =>
      stubRecords().some(
        (entry) => entry.kind === "prompt" && entry.text.includes("queued-by-owner"),
      ),
    );
  });

  it("keeps a letter queued in a busy conversation out of its exchange until it is dispatched", async () => {
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
      `[stub:until bruno-may-write] ${stubCall("bot_message", toAlice("first-from-bruno"))}`,
    );
    await waitStatus(brunoThread, "active");
    // Bruno's own exchange starts with his first letter in this turn.
    const before = exchangeOf(brunoThread);
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
      { chain: before.chain, waiting: 1 },
      `a queued letter leaves Bruno's exchange alone; the queue: ${JSON.stringify(
        (await server.api("GET", `/threads/${brunoThread}/queued-messages`)).map((row) => [
          row.state,
          row.waitingOn,
        ]),
      )}; Alice's exchange: ${JSON.stringify(exchangeOf(aliceThread))}`,
    );
    const alicesExchange = exchangeOf(aliceThread).chain;
    assert.ok(alicesExchange);
    // Bruno's turn waits for this signal, so the queue is read while it runs.
    signal("bruno-may-write");
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
    // "Letter 1/" is the proof that Bruno's letter opened his own exchange:
    // Alice's already holds her letter, so joining it would number his 2.
    // Reading the table here would race the queue draining once his turn ends.

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
  });
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
    fixture.parent = regularThread(projects.alpha, "Stock parent");
    fixture.parentChild = regularThread(projects.alpha, "Stock child", "[stub:reply child]", [
      "--parent-thread",
      fixture.parent,
    ]);
    fixture.v1 = await startConversation(fixture.visible, "[stub:reply v1]", projects.alpha);
    fixture.v2 = await startConversation(fixture.visible, "[stub:reply v2]", projects.alpha);
    fixture.h1 = await startConversation(fixture.hidden, "[stub:reply h1]", projects.beta);
    await rename(fixture.v1, "Bot conversation one");
    await rename(fixture.v2, "Bot conversation two");
    await rename(fixture.h1, "Hidden bot conversation");
    await Promise.all(
      [fixture.plain, fixture.parent, fixture.parentChild, fixture.v1, fixture.v2, fixture.h1].map(
        (id) => waitTurns(id, 1),
      ),
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
        const [afterBots, betweenProjects] = await Promise.all([
          gapAbove(page, "Alpha"),
          gapAbove(page, "Beta"),
        ]);
        assert.ok(
          Math.abs(afterBots - betweenProjects) <= 2,
          `the bots block ends with the gap between project groups (${afterBots}px vs ${betweenProjects}px)`,
        );
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

        const botName = page.locator(`[data-bot-id="${fixture.visible.id}"] .bb-thread-title`, {
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

  it("draws a bot like bb's parent thread and the block header like a project header", async () => {
    const { context, page, problems } = await openApp(browser, "dark");
    try {
      await waitDrawn(page, threadLink(page, fixture.parentChild), "stock-child");
      await expandBot(page, "Visual Bot");
      await threadLink(page, fixture.v1).waitFor({ timeout: 30 * SECOND });
      // The row itself, not the project group around it, which is a rename
      // row too.
      const stockRow = page.locator("[data-sidebar-rename-row].group\\/thread-row", {
        has: threadLink(page, fixture.parent),
      });
      const botRow = page.locator(`[data-bot-id="${fixture.visible.id}"] [data-1ma-bot-row]`);
      const clip = async (top, bottom) => {
        const [a, b] = [await top.first().boundingBox(), await bottom.first().boundingBox()];
        return { x: 48, y: a.y - 8, width: 272, height: b.y + b.height - a.y + 16 };
      };

      await stockRow.hover();
      const stock = await parentRowGeometry(page, {
        row: stockRow,
        title: stockRow.locator(".bb-thread-title"),
        chevron: stockRow.getByRole("button", {
          name: "Collapse Stock parent threads",
          exact: true,
        }),
        child: threadLink(page, fixture.parentChild),
      });
      await page.screenshot({
        path: `${screenshotDir}/compare-stock-parent-hover.png`,
        clip: await clip(stockRow, threadLink(page, fixture.parentChild)),
      });

      await botRow.hover();
      const bot = await parentRowGeometry(page, {
        row: botRow,
        title: botRow.locator(".bb-thread-title"),
        chevron: botRow.getByRole("button", {
          name: "Collapse Visual Bot conversations",
          exact: true,
        }),
        child: threadLink(page, fixture.v1),
      });
      await page.screenshot({
        path: `${screenshotDir}/compare-bot-hover.png`,
        clip: await clip(botRow, threadLink(page, fixture.v2)),
      });

      assert.ok(
        Math.abs(bot.chevronAfterTitle - stock.chevronAfterTitle) <= 1,
        JSON.stringify({ bot, stock }),
      );
      assert.deepEqual(bot.chevronSize, stock.chevronSize, "the chevron is bb's");
      assert.equal(
        bot.background,
        stock.background,
        "a hovered bot row is highlighted like a thread row",
      );
      assert.ok(Math.abs(bot.childIndent - stock.childIndent) <= 1, JSON.stringify({ bot, stock }));
      assert.equal(
        bot.childPadding,
        stock.childPadding,
        "conversations are indented as sub-threads",
      );
      assert.notEqual(stock.guide, null, "the stock parent draws a guide line");
      assert.equal(bot.guide, stock.guide, "the guide line sits where bb draws it");

      const projectNew = page.getByRole("button", { name: "New thread in Alpha", exact: true });
      const [stockIcon, botIcon, headerIcon] = await Promise.all([
        iconOf(projectNew),
        iconOf(page.getByRole("button", { name: "New conversation with Visual Bot", exact: true })),
        iconOf(page.getByRole("button", { name: "New bot", exact: true })),
      ]);
      assert.ok(stockIcon !== null);
      assert.equal(botIcon, stockIcon, "the bot's + is bb's new-thread icon");
      assert.equal(headerIcon, stockIcon, "the Bots header's + is bb's new-thread icon");

      const botsHeader = page.getByText("Bots", { exact: true }).first();
      const alphaHeader = page.getByText("Alpha", { exact: true }).first();
      await botsHeader.hover();
      await page.screenshot({
        path: `${screenshotDir}/compare-bots-header-hover.png`,
        clip: await clip(botsHeader, botsHeader),
      });
      await alphaHeader.hover();
      await page.screenshot({
        path: `${screenshotDir}/compare-project-header-hover.png`,
        clip: await clip(alphaHeader, alphaHeader),
      });

      await botRow.hover();
      await page.getByRole("button", { name: "Visual Bot actions" }).click();
      await page.getByRole("menuitem", { name: "Bot settings" }).click();
      await page.locator("ul li button", { hasText: "Visual Bot" }).first().click();
      await page
        .getByText("Instructions", { exact: true })
        .first()
        .waitFor({ timeout: 30 * SECOND });
      await screenshot(page, "bot-settings-page");
      assert.deepEqual(problems, []);
    } finally {
      await context.close();
    }
  });

  it("orders, completes and nests conversations in the bot tree", async () => {
    const { context, page } = await openApp(browser, "light");
    try {
      await expandBot(page, "Visual Bot");
      const group = page.locator(`[data-bot-id="${fixture.visible.id}"]`);
      const row = threadLink(group, fixture.v2);
      await row.click({ button: "right" });
      await page.getByRole("menuitem", { name: "Move to top", exact: true }).click();
      const order = () =>
        group
          .locator("a[data-sidebar-thread-id]")
          .evaluateAll((rows) => rows.map((link) => link.dataset.sidebarThreadId));
      await waitFor(
        "the menu moves the second conversation to the top",
        30 * SECOND,
        async () => (await order())[0] === fixture.v2,
      );
      await row.click({ button: "right" });
      const markDone = page.getByRole("menuitem", { name: "Mark as done", exact: true });
      await markDone.waitFor();
      await screenshot(page, "bot-conversation-menu");
      await markDone.click();
      await row.waitFor({ state: "detached" });
      await group.getByRole("button", { name: "Done: 1", exact: true }).click();
      await row.waitFor();
      assert.equal(await completedOf(fixture.visible.id, fixture.v2), true);
      await screenshot(page, "bot-conversation-done");
      await row.click({ button: "right" });
      await page.getByRole("menuitem", { name: "Mark as not done", exact: true }).click();
      await group
        .getByRole("button", { name: "Done: 1", exact: true })
        .waitFor({ state: "detached" });
      await row.waitFor();
      assert.equal(await completedOf(fixture.visible.id, fixture.v2), false);
      const overParent = (selector) =>
        group.locator(selector).filter({ has: threadLink(page, fixture.v1) });
      const drag = async (placement, hint, shot) => {
        const from = await row.boundingBox();
        const parent = threadLink(group, fixture.v1);
        const to = await parent.boundingBox();
        assert.ok(from && to);
        const x = to.x + 36;
        const y = placement === "inside" ? to.y + to.height / 2 : to.y + to.height - 2;
        await page.mouse.move(from.x + 36, from.y + from.height / 2);
        await page.mouse.down();
        await page.mouse.move(from.x + 46, from.y + from.height / 2 + 3, { steps: 4 });
        await page.mouse.move(x, y, { steps: 18 });
        await hint.waitFor({ timeout: 10 * SECOND });
        await screenshot(page, shot);
        await page.mouse.up();
      };
      await drag(
        "after",
        overParent('[data-sidebar-reorder-placement="after"]'),
        "bot-conversation-reorder",
      );
      await waitFor(
        "the drag changes the saved bot order",
        30 * SECOND,
        async () =>
          (await rpc("bots.v1.get", { botId: fixture.visible.id })).threads[0].threadId ===
            fixture.v1 && (await order())[0] === fixture.v1,
      );
      await drag(
        "inside",
        overParent('[data-sidebar-nest-target="valid"]'),
        "bot-conversation-nest",
      );
      await waitFor(
        "the dragged conversation has a real parent",
        30 * SECOND,
        async () => (await thread(fixture.v2)).parentThreadId === fixture.v1,
      );
      // bb tells the new parent about its child two seconds later; until that
      // turn ends, its branch does not go to Done.
      await waitNotice(fixture.v1, "ownership-assigned", fixture.v2);
      await waitStatus(fixture.v1, "idle");
      await page.reload();
      await expandBot(page, "Visual Bot");
      await group
        .getByRole("button", { name: "Collapse Bot conversation one threads", exact: true })
        .waitFor();
      assert.deepEqual(await order(), [fixture.v1, fixture.v2]);
      await screenshot(page, "bot-conversation-subchat");

      await threadLink(group, fixture.v1).click({ button: "right" });
      await page.getByRole("menuitem", { name: "Mark as done", exact: true }).click();
      await row.waitFor({ state: "detached" });
      assert.deepEqual(await order(), [], "the sub-chat leaves with its parent");
      await group.getByRole("button", { name: "Done: 1", exact: true }).click();
      await row.waitFor();
      assert.deepEqual(await order(), [fixture.v1, fixture.v2]);
      await screenshot(page, "bot-conversation-branch-done");
      await row.click({ button: "right" });
      await page.getByRole("menuitem", { name: "Mark as not done", exact: true }).click();
      await group
        .getByRole("button", { name: "Done: 1", exact: true })
        .waitFor({ state: "detached" });
      await row.waitFor();
      assert.deepEqual(await order(), [fixture.v1, fixture.v2]);
      assert.equal(await completedOf(fixture.visible.id, fixture.v1), false);

      // Below an open branch the line is drawn under all of it, not under its first row.
      await drag(
        "after",
        overParent(".after\\:bg-sidebar-ring").filter({ has: threadLink(page, fixture.v2) }),
        "bot-conversation-below-branch",
      );
      await waitFor(
        "the edge of a top-level conversation takes the sub-chat out",
        30 * SECOND,
        async () => (await thread(fixture.v2)).parentThreadId === null,
      );
      await group
        .getByRole("button", { name: "Collapse Bot conversation one threads", exact: true })
        .waitFor({ state: "detached" });
      assert.deepEqual(await order(), [fixture.v1, fixture.v2]);
      await screenshot(page, "bot-conversation-out-of-parent");
    } finally {
      await context.close();
      await rpc("bots.v1.setCompleted", { threadId: fixture.v1, completed: false });
      await server.api("PATCH", `/threads/${fixture.v2}`, { parentThreadId: null });
    }
  });

  it("leaves conversations where they are when dragged between the open list and Done, and their parents when dragged inside Done", async () => {
    const bot = await createBot("Order Bot");
    const ids = [];
    for (const name of ["one", "two", "three", "four"]) {
      const id = await startConversation(bot, `[stub:reply order-${name}]`);
      ids.push(id);
      await rename(id, `Order ${name}`);
      await waitTurns(id, 1);
      await waitStatus(id, "idle");
    }
    const members = async () => (await rpc("bots.v1.get", { botId: bot.id })).threads;
    const [open1, open2, done1, done2] = (await members()).map((member) => member.threadId);
    const parents = () =>
      Promise.all(
        [open1, open2, done1, done2].map(async (id) => (await thread(id)).parentThreadId ?? null),
      );
    for (const threadId of [done1, done2]) {
      await rpc("bots.v1.setCompleted", { threadId, completed: true });
    }
    // Its parent is open, so Done draws it at the top level.
    await server.api("PATCH", `/threads/${done1}`, { parentThreadId: open1 });
    const before = await members();
    const { context, page } = await openApp(browser, "light");
    try {
      await expandBot(page, "Order Bot");
      const group = page.locator(`[data-bot-id="${bot.id}"]`);
      await group.getByRole("button", { name: "Done: 2", exact: true }).click();
      await threadLink(group, done2).waitFor();
      const chip = page.locator(
        "[data-sidebar-section-drag-overlay]:not([data-sidebar-touch-armed-chip])",
      );
      const drag = async (fromId, toId, offset, held) => {
        const from = await threadLink(group, fromId).boundingBox();
        const to = await threadLink(group, toId).boundingBox();
        assert.ok(from && to);
        await page.mouse.move(from.x + 36, from.y + from.height / 2);
        await page.mouse.down();
        await page.mouse.move(from.x + 46, from.y + from.height / 2 + 3, { steps: 4 });
        await page.mouse.move(to.x + 36, to.y + offset(to.height), { steps: 18 });
        await chip.waitFor({ timeout: 10 * SECOND });
        await held();
        await page.mouse.up();
        await chip.waitFor({ state: "detached" });
      };
      const hints = group.locator(
        '[data-sidebar-reorder-placement], [data-sidebar-nest-target="valid"]',
      );
      const places = {
        top: () => 2,
        middle: (height) => height / 2,
        bottom: (height) => height - 2,
      };
      for (const [from, to, shot] of [
        [open2, done1, "bot-conversation-open-over-done"],
        [done1, open2, "bot-conversation-done-over-open"],
      ]) {
        for (const [place, offset] of Object.entries(places)) {
          await drag(from, to, offset, async () => {
            // Longer than a row needs under the pointer to become the parent.
            await page.waitForTimeout(SECOND);
            if (place === "middle") await screenshot(page, shot);
            assert.equal(await hints.count(), 0, `${shot} offers nothing at the ${place}`);
          });
        }
      }
      // The same gesture inside the open list does move, so the ones above were drags.
      await drag(open1, open2, places.bottom, () =>
        group.locator('[data-sidebar-reorder-placement="after"]').waitFor(),
      );
      await waitFor(
        "the drag inside the open list is saved",
        30 * SECOND,
        async () => (await members())[0].threadId === open2,
      );
      const [first, second, ...rest] = before;
      assert.deepEqual(await members(), [second, first, ...rest]);
      assert.deepEqual(await parents(), [null, null, open1, null]);
      await drag(done2, done1, places.top, async () => {
        await group.locator('[data-sidebar-reorder-placement="before"]').waitFor();
        await screenshot(page, "bot-conversation-order-in-done");
      });
      await waitFor(
        "the drag inside Done is saved",
        30 * SECOND,
        async () => (await members())[2].threadId === done2,
      );
      assert.deepEqual(await members(), [second, first, rest[1], rest[0]]);
      assert.deepEqual(await parents(), [null, null, open1, null]);
      assert.equal(
        await group.getByRole("button", { name: "Done: 2", exact: true }).count(),
        1,
        "both done conversations are still there",
      );
      await rpc("bots.v1.setCompleted", { threadId: done2, completed: false });
      await group.getByRole("button", { name: "Done: 1", exact: true }).waitFor();
      assert.deepEqual(await parents(), [null, null, open1, null]);
    } finally {
      await context.close();
      await server.api("PATCH", `/threads/${done1}`, { parentThreadId: null });
      await rpc("bots.v1.remove", { botId: bot.id });
      for (const id of ids) server.bb(["thread", "archive", id]);
    }
  });

  it("moves a conversation dragged from a project onto a bot's face to the top of that bot", async () => {
    const { context, page, problems } = await openApp(browser, "light");
    try {
      await waitDrawn(page, threadLink(page, fixture.plain), "plain-thread");
      await expandBot(page, "Visual Bot");
      const botScope = `[data-bot-id="${fixture.visible.id}"]`;
      const face = page.locator(`${botScope} [data-1ma-bot-avatar]`);
      const from = await threadLink(page, fixture.plain).boundingBox();
      const to = await face.boundingBox();
      assert.ok(from !== null && to !== null);
      await page.mouse.move(from.x + 40, from.y + from.height / 2);
      await page.mouse.down();
      // dnd-kit starts after a short move; then travel to the bot in steps.
      await page.mouse.move(from.x + 46, from.y + from.height / 2 + 6, { steps: 4 });
      await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 20 });
      await page.mouse.move(to.x + to.width / 2 + 2, to.y + to.height / 2 + 1, { steps: 2 });
      await screenshot(page, "drag-onto-bot");
      await page
        .locator(`${botScope} [data-1ma-drop-place="first"]`)
        .waitFor({ timeout: 10 * SECOND });
      await page.mouse.up();
      await page
        .locator(`${botScope} a[data-sidebar-thread-id="${fixture.plain}"]`)
        .waitFor({ timeout: 30 * SECOND });
      const ids = await page
        .locator(`${botScope} a[data-sidebar-thread-id]`)
        .evaluateAll((links) => links.map((link) => link.getAttribute("data-sidebar-thread-id")));
      assert.equal(ids[0], fixture.plain, "the dropped conversation is the bot's first");
      assert.equal(await threadLink(page, fixture.plain).count(), 1, "it left its project");
      const { bots } = await rpc("bots.v1.list", {});
      assert.equal(
        bots.find((bot) => bot.id === fixture.visible.id).threads[0].threadId,
        fixture.plain,
      );
      assert.deepEqual(problems, []);
    } finally {
      await context.close();
      await rpc("bots.v1.assign", { threadId: fixture.plain, botId: null });
    }
  });

  it("returns a hidden bot and its conversation to the open sidebar when work starts", async () => {
    const { context, page } = await openApp(browser, "light");
    const bot = page.locator(`[data-bot-id="${fixture.hidden.id}"]`);
    try {
      await waitDrawn(page, page.getByText("1 hidden", { exact: true }), "bot-waiting-for-work");
      await threadLink(page, fixture.h1).waitFor();
      assert.equal(await bot.count(), 0);
      await say(fixture.h1, "[stub:until hidden-bot-working]");
      await waitStatus(fixture.h1, "active");
      await waitDrawn(page, threadLink(bot, fixture.h1), "bot-returned-to-work");
      await page.locator("[data-1ma-hidden-bots]").waitFor({ state: "detached" });
      assert.equal(await threadLink(page, fixture.h1).count(), 1);
      assert.equal((await rpc("bots.v1.get", { botId: fixture.hidden.id })).hidden, false);
      await screenshot(page, "hidden-bot-returned-to-work");
    } finally {
      signal("hidden-bot-working");
      await context.close();
    }
  });

  it("keeps a fork with its bot, previews its instructions and returns it to the project on No bot", async () => {
    const bot = await createBot("Editor", {
      role: "Copy editor",
      instructions: "Use short sentences.",
    });
    const source = await startConversation(bot, "[stub:reply source]", projects.beta, {
      providerId: "acp-omp",
    });
    await waitTurns(source, 1);
    await waitStatus(source, "idle");
    await rename(source, "Original draft");
    await rpc("bots.v1.setCompleted", { threadId: source, completed: true });
    const fork = await server.api("POST", "/threads/fork", {
      sourceThreadId: source,
      title: "Revised draft",
      input: [{ type: "text", text: "[stub:reply revised]", mentions: [] }],
    });
    await waitStatus(fork.id, "idle");
    const first = stubRecords().find(
      (entry) => entry.kind === "prompt" && entry.text.includes("[stub:reply revised]"),
    );
    assert.ok(first, "the agent received the fork's first message");
    const forkSession = stubRecords().find(
      (entry) => entry.kind === "fork" && entry.sessionId === first.sessionId,
    );
    assert.ok(forkSession, "the first message reached the session returned by session/fork");
    assert.notEqual(forkSession.sessionId, forkSession.sourceSessionId);
    assert.ok(
      stubRecords().some(
        (entry) =>
          entry.kind === "prompt" &&
          entry.sessionId === forkSession.sourceSessionId &&
          entry.text.includes("[stub:reply source]"),
      ),
      "the fork cloned the original conversation",
    );
    await waitFor("bot_read in the fork's first session", 60 * SECOND, async () =>
      stubRecords().some(
        (entry) =>
          entry.kind === "tools" &&
          entry.sessionId === forkSession.sessionId &&
          entry.tools?.includes("bot_read"),
      ),
    );
    const { context, page } = await openApp(browser, "light");
    try {
      const group = page.locator(`[data-bot-id="${bot.id}"]`);
      await waitDrawn(page, threadLink(group, fork.id), "continued-bot-conversation");
      assert.deepEqual(
        await group
          .locator("a[data-sidebar-thread-id]")
          .evaluateAll((rows) => rows.map((row) => row.dataset.sidebarThreadId)),
        [fork.id, source],
      );
      await threadLink(group, fork.id).click();
      const info = page.getByRole("button", { name: "Show thread info panel" });
      const preview = page.getByRole("button", { name: "View bot instructions" });
      if (!(await preview.isVisible())) {
        if (!(await info.isVisible()))
          await page.getByRole("button", { name: "Show right panel" }).click();
        if (!(await preview.isVisible())) await info.click();
      }
      await preview.click();
      const dialog = page.getByRole("dialog", { name: "Instructions from Editor" });
      await dialog.getByText("Use short sentences.", { exact: false }).waitFor();
      await page.screenshot({
        path: `${screenshotDir}/continuation-bot-instructions.png`,
        animations: "disabled",
      });
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "Editor", exact: true }).click();
      await page.getByRole("menuitem", { name: "No bot" }).click();
      await threadLink(group, fork.id).waitFor({ state: "detached" });
      await threadLink(page, fork.id).waitFor();
      assert.equal(
        (await groupsOf(page, ["Bots", "Alpha", "Beta"], [fork.id])).groupOf[fork.id],
        "Beta",
      );
      assert.equal(await rpc("bots.v1.forThread", { threadId: fork.id }), null);
    } finally {
      await context.close();
      await rpc("bots.v1.remove", { botId: bot.id });
    }
  });

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
