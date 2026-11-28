# 1ma cloud and teams

25.11.2026, revised 28.11.2026. Direction agreed with the owner topic by topic on 24–28.11.2026;
choices still open are in «Open decisions». Nothing here is built, bought or registered. Durations
are estimates, not promises.

## Two approvals

**Approving this plan now** confirms it as the basis for the stage documents, and nothing more:
the owner said on 28.11 that implementation starts later. Until the owner gives the explicit start
of approval 1, nobody creates projects, accounts, repositories, prototypes or product code, and the
budget is $0. Both approvals below are asked then, one after the other.

The owner's decision of 25.11: «В два шага (Рекомендую)». Each approval says what it allows.

1. **Direction and research on made-up data.** Allows: this document's direction; prototypes of
   sign-in and of the required start; the check of earlier chats; the design system's first part; a
   private repository for the account service. Accounts: test projects of Supabase (Free) and Google,
   test mail, and test identities made for it, never a person's own. Budget: **$0**. A paid test (the
   28 days need Supabase Pro, $25 a month) is asked separately with its price before ordering. No
   real person's data, no client.
2. **Building the first client release.** After the research: the decisions marked «approval 2»
   in «Open decisions», the screens and failures of stage 1 in plain words, the costs below. Allows
   product code for clients and the production setup named in «Order of work». It does not by itself
   allow giving a build to anyone: that follows «Done when» and the launch card («Who may be given
   what»), without a third vote.

Stages 2 and 3 are not approved by either; each gets its own document («Left for later»).

## Rules

- **For whom**: solo entrepreneurs, people and small businesses. Enterprise needs (company single
  sign-on, custom roles, audit exports, admin consoles, certificates) come later, except that
  people and companies share one data model from the start.
- **Small and without errors** beats large.
- **Nothing is invented.** Before each important task: research of best practice and free open
  source, with licence, activity and fit written down; then copy 1:1, or borrow the architecture,
  or say why neither works.
- **Free for the client.** Basic functions come with 1ma; the client does not buy a third-party
  service for them. They customize the rest themselves.
- **One design system.** New 1ma screens use only its components; a missing one is added to it
  first.

## The first agency on one page

Five people, each on an own Mac with an Apple chip. This is what they get in stage 1.

| Question                    | Answer                                                                                                                                                                                              |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Which Macs                  | Each person's own. Chip, macOS version and the right to install are checked for all five before agreeing                                                                                            |
| What is installed           | 1ma with personal tasks, Claude Code or Codex, by the owner together with the person                                                                                                                |
| Not in it                   | Shared chats, files or board, access from a browser or phone, work around the clock                                                                                                                 |
| Who signs                   | The agency and the operator named in the private launch card. Free or paid: «Who may be given what»                                                                                                 |
| What 1ma's cloud sees       | Name, email, Google's id and picture link, times of sign-in and renewal, IP address and browser of the sign-in, a Google sign-in in progress, state of the account («Data»). Not chats, files, tasks or model keys |
| What Claude or Codex sees   | What the person and their agent include in requests: messages, and files the agent reads for the work, under the vendor's terms                                                                     |
| The agency pays             | Its Claude seats to Anthropic (US price before tax: $125 a month for five, or $1,200 a year; nothing new if it has them), the services it ordered. The app is free                                  |
| The owner pays              | About $35 a month in stage 1: two small Supabase projects and Resend's free mail. The recommended EU mail provider (decision 6) adds its quoted price («Cost»). Apple: $99 a year at level 5, separately; the local price may differ |
| Claude would be paid by key | Found before the first request: a screen, no request. The agency may choose its own key at the price and limit agreed before                                                                        |
| Claude refuses the plan     | A clear screen, no automatic paid request                                                                                                                                                           |
| No network                  | Whoever is signed in continues until the date shown (28 days from the last renewal); the model itself needs the network. A new person cannot sign in                                                |
| 1ma's cloud is down         | The same. Whoever reaches the date during the outage waits                                                                                                                                          |
| An account is blocked       | The sign-in screen appears at the next check (below), at the latest on the date. Files stay. An agent that was already running continues                                                            |
| The pilot ends              | On the card's end date: no new sign-in or renewal; an open app closes its screen at the next check, offline on the same date                                                                        |
| A person leaves             | The agency's named contact asks; the operator ends that person's admission before the mailbox or Mac goes to anybody else. Who keeps the files on the Mac is the agency's agreement with the person |
| Earlier chats do not arrive | They stay in Claude Code and Codex untouched. The agency knows which ones arrive before it agrees, or starts without them                                                                           |
| A Mac goes to somebody else | Old 1ma is stopped; the next person gets a clean 1ma and does not see old chats. Moving chosen old content is a separate permitted step                                                             |

bb has no users or roles: whoever reaches a server can act with the rights of the account it runs
under. Privacy between colleagues comes from each having their own 1ma. 1ma does not promise that
the app cannot be examined, that all data stays in the EU, or that nobody can technically see
Connect traffic.

## Owner's decisions

| Topic              | Decision                                                                                                                                                                                                        |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Income             | Services, 25.11: building agents and automations, training, rollout, setup, support. Not from model tokens: vendors' terms forbid reselling them. People may use 1ma free. No payment system in the app         |
| Two approvals      | «В два шага (Рекомендую)», 25.11 («Two approvals»)                                                                                                                                                              |
| Required start     | «Да, как у них (Рекомендую)», 25.11 (decision 1): as Codex does it, the app's own code checks the account at every start, by a small bb patch; where our server gives a service (stages 2–3) it refuses too     |
| Language           | English interface only; new screens get no Russian strings. The bilingual rule of `AGENTS.md` no longer applies to them (editing that file: decision 9a)                                                        |
| Order              | Personal app first, then Connect; company functions, the shared board last                                                                                                                                      |
| Board              | Free with 1ma, from open source; not a paid service. Later; personal tasks first                                                                                                                                |
| Integrations       | 1C, Directum and similar: outside these stages                                                                                                                                                                  |
| Computers          | Mac first, installed by the owner; Windows in parallel, checked on a rented machine, given to clients when stable                                                                                               |
| Apple Developer ID | Bought by the company when it takes over («Who may be given what»)                                                                                                                                              |
| Update signature   | «Менеджер паролей (Рекомендую)», 25.11: the owner creates the private key and keeps it in their password manager, no agent ever sees it; a second, reserve public key is in the app from the first signed build |
| Account            | Required at the first start; no client is installed before sign-in works                                                                                                                                        |
| Sign-in            | As Claude does it: Google or email, no passwords, 28 days renewed by use, «log out on all devices». The client is told 1ma's own terms and times («Session and block»)                                          |
| Account disabled   | The app shows the sign-in screen; chats and files on the computer are not deleted                                                                                                                               |
| Cloud outage       | A client whose 28 days end during an outage waits; new people cannot sign in until it ends                                                                                                                      |
| Connect            | Stage 2. One 1ma gateway in the EU, stores devices and sign-in times, no end-to-end encryption (said openly)                                                                                                    |
| Team               | Own closed 1ma per employee; no shared chats or bots                                                                                                                                                            |
| Hosting            | Supabase in a named EU region                                                                                                                                                                                   |
| Account service    | Proposed, not yet a decision: code in a separate private repository, created under approval 1                                                                                                                   |
| Downloads          | A separate public GitHub repository with builds only                                                                                                                                                            |
| Source             | Public during active development; closing it is decided later                                                                                                                                                   |
| Models             | Clients' own subscriptions, as the owner's, are preferred; the condition is open decision 4. No letter or lawyer is required for it                                                                             |

## Who may be given what

**One rule.** A real person needs level 2. Any payment adds level 3. Any Mac build sent by link or
installed by the client adds levels 4 and 5. The private **launch card** (not in this repository)
records for each client: the permitted case, the people admitted with their end dates, who signs
with the client and with each supplier, in which role and from which date, who answers requests,
and who confirms the move to the company.

| Level                 | Needed                                                                                                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1. Made-up data       | Approval 1                                                                                                                                                               |
| 2. A real person      | Approval 2; stage 1 «Done when»; the operator, client terms, privacy policy, supplier agreements and a contact are confirmed in the card, also for a free pilot          |
| 3. Payment            | Written confirmation from an accountant or lawyer that the operator named in the card may invoice and receive money for it                                               |
| 4. Company takes over | The company can sign for itself, its signer is confirmed, and contracts, invoices, data roles, domain and provider accounts are moved as the card lists; people are told |
| 5. Apple-signed build | Level 4; the company's Apple Developer ID; a signed and notarized release tested on a clean Mac                                                                          |

| Case                                               | Rule                                                                                                                                    |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Free pilot before level 4, unsigned build          | Level 2, only if chosen in decision 2: by the owner in person, on the Macs and for the people named in the card, with an end date       |
| Paid installation before level 4, unsigned build   | Levels 2 and 3, only if chosen in decision 2: in person, the client knows macOS will warn and that contracts will move. Not recommended |
| Free installation after level 4, unsigned build    | Levels 2 and 4, in person, as the free pilot (part of decision 2)                                                                       |
| Paid installation after level 4, unsigned build    | Levels 2, 3 and 4, in person                                                                                                            |
| Build sent by link, or installed by the client     | Levels 2, 4 and 5; and 3 if paid                                                                                                        |
| A stranger finds the download and tries to sign in | Refused, by Google and by email alike; no account is created and no letter is sent                                                      |

If decision 2 is «wait for the company», the company starts itself at level 4. If a pilot ran
before, the card lists what moves: people, accounts, contracts, data.

**Admission** is a server-side list kept by the operator: a person, an email, an end date, and an
entry id that is new for every admission, even with the same address. Supabase checks a new
account only once, and lets an existing confirmed account get a letter and a session without that
check, also through Google. So the list is checked on the server at three places, with hooks Supabase
offers on Free and Pro: before an account is created («before user created»), before any sign-in
letter is sent («send email»: no letter to an address without an active admission), and whenever a
token is issued or renewed («custom access token»: no token after the end date, a removal or a
block; the end date travels in the token). This last hook also checks the block itself, because
Supabase's exchange of a Google code does not. Removing a person also bans the account and ends all
its sessions, so enabling it again needs a new sign-in; old sessions do not come back. The email form
answers everybody the same. «No letter» means no letter for a request made after the removal. Test
mail is checked with a made-up address outside the project's team, and the hook's refusal has no
fallback to Supabase's own mail. Google may still show its own page before 1ma refuses; the promise
is about 1ma's account and 1ma's letter.

| Who signs in                                        | Expected                                                                                                                                                |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A new stranger                                      | No account, no letter, no session                                                                                                                       |
| A former participant, or a pilot past its end date  | No letter, no session, no renewal; an open app follows «Session and block»                                                                              |
| A new employee given a former participant's address | A new admission and a new account id, by Google and by email; an old directory stays closed                                                             |
| An admitted person                                  | Signs in by Google or email                                                                                                                             |

**Passing on an address.** Changing the old account's email is not enough: Supabase keeps the old
Google sign-in with its own copy of the address and would lead the new person back to the old
account. Before a shared mailbox or a Mac goes to somebody else, the operator ends the admission and
deletes the old account with all its sign-in methods, or removes every one of them, and checks that
the address now leads nowhere. Until that check passes, the operator's screen shows a refusal or the
next step, not a finished hand-over. The server issues the admission entry id for that account; the
local binding checks the pair of account id and admission id, so a re-issued address never opens
the old directory. Tested separately: the old account, a sign-in started in the browser before the
hand-over, and the old local directory.

**Data.** Named in the card: who does it, what it contains, format, term, stores, the parties' roles
as they really act, and the basis for any transfer outside the EU (checked before level 2). Deleting
the current record, database copies, logs and a mail provider's request are separate steps with their
own terms.

**Restoring a copy** never brings back what was taken away after it. Before a restored service
opens, the deletions, ended admissions and blocks made since the copy are applied again, and the
restored sessions are ended unless each one is confirmed as current. The record of those changes is
kept apart from the database; where is decided in the stage 1 document.

Accepted when: one test account's export is compared with every store below, holds nobody else's
rows and keeps secret values out; it is deleted; one copy made before the following is restored and
checked for three cases before the service opens: a deleted account stays deleted; a person removed
from the pilot early gets no letter and no sign-in; a session revoked after the copy does not
continue. The privacy text does not promise that this deletes files or traces at other suppliers.
Files on the person's Mac are not touched by it.

| Data                                                                  | Received by                 | Where                                      | Kept                                                                                             |
| --------------------------------------------------------------------- | --------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| Account, admission, sign-in times; Google's id, name and picture link | Supabase                    | EU region                                  | Until deletion; Pro's daily database copies 7 days                                               |
| IP address and browser of sessions and sign-in events                 | Supabase                    | Sessions in the EU region; logs to confirm | Sessions until removed; logs by their own terms                                                  |
| Google sign-in in progress: the code, Google's access and refresh tokens | Supabase                 | EU region                                  | Until the exchange; an abandoned one until cleanup, its term checked after cancel and crash in stage 1 |
| Google sign-in                                                        | Google                      | Google's terms                             | Google's terms; only the basic scopes (email, profile) are asked                                 |
| Sign-in mail: address and letter                                      | Mail provider (decision 6)  | Resend: USA                                | Resend: 30 days on Free, Pro, Scale; earlier deletion of named letters by request to its support |
| Prompts and files for the model                                       | The person's model provider | Its terms                                  | Its terms; not 1ma's cloud                                                                       |

The client list shows the operator name, email, dates and state; the stores above hold more. If the
operator's functions run as Supabase Edge Functions, they are pinned to the project's region, since
by default they run near the caller.

## Stage 1: account and the first client

### Design system first

It exists: bb ships shadcn/Radix components as vendored source (110 registry items in bb 0.49.0, among them
calendar, table and command primitives), tokens in `theme.css`, light and dark. Plugins copy
components; a copy does not update itself. 1ma's theme plugin equals bb's default today.

A separate task with its own document and the owner's approval of the look, without a bb patch:
1ma values in `1ma-theme`; a 1ma registry of pinned bb items plus missing compositions (checked
one by one, such as date picker, multi-select, people picker); a usage guide that is also an agent
skill, because clients' agents build with it; a gallery plugin and a drift check. **First part**,
1–2 weeks: what sign-in, errors and the client list need. Accepted: gallery in both themes,
contrast at WCAG 2.2 AA (4.5:1 for text, 3:1 for controls), the owner approves the look.

### Sign-in

Reused: Supabase Auth and its documented patterns; `termcanvas` (MIT) as a pattern for a desktop
loopback; parts of the owner's earlier Supabase project only after its contributors' written
permission. Without it the first two suffice.

- Google: system browser, PKCE, one-time loopback address; the exchange happens in 1ma's own
  server process. This fits the Mac app; a remote server needs another way (stage 2).
- A published Google app needs a public page with a description and a privacy policy on a domain
  verified as ours; our terms are on it for clients. Test and production are separate Google
  projects.
- Email: «link» was decided on 24.11; a code typed into the app is proposed instead (decision 5):
  mail scanners open links, and a link works only in the place that asked for it. If the link stays,
  the screens also cover a link already used or expired, and a link opened on another Mac.
- Google and email with the same verified address reach the same account. No codes or tokens in
  logs; Supabase's own rate limits and captcha. Supabase's built-in mail sends only to the project's
  team, two letters an hour: tests use the test mail account, not it.
- Tokens are kept in the system's secure store (Keychain on the Mac), never in plain files or logs.
- The client list is refused to an ordinary user, also one with a second factor, and to the operator
  without one; disabling and enabling again are both tested.
- The client list is a tab in the owner's own 1ma: name, email, created, last sign-in or renewal,
  state.

### Required sign-in

A plugin's screen alone does not meet «required»: it shows nothing when the plugin fails, and an
installation that has finished bb's introduction skips a step placed there. So the decision is made
around the app's main pages at **every** start by a small bb patch. The owner agreed on 25.11
(decision 1); it is a condition of a client release, and its code waits for approval 2. Adding the plugin also changes patch 0014 and
`desktop/embedded-plugins.json`. The screen controls the app we ship and is not copy protection.

| At start                                | Shown                                                        |
| --------------------------------------- | ------------------------------------------------------------ |
| New installation                        | Sign-in, then bb's introduction                              |
| Earlier installation without an account | Sign-in, then the question to take over the work on this Mac |
| Valid answer, plugin works              | The app                                                      |
| Plugin fails, kept answer still valid   | The app, with a notice                                       |
| Plugin fails, no answer or it ended     | Error screen: retry, log, support text; files untouched      |
| Another person's account                | Explanation; the workspace stays closed                      |

**One installation, one person.** bb keeps all chats in one database. Requirements:

- One source of truth on the local server: unbound, or bound to a stable account id and admission
  entry. «Signed in» and «may open this work» are separate states. A kept answer is valid only for
  the account and the directory it was given for; a second window or a missing plugin does not
  widen it.
- Taking over is one conditional step on that server: «if still unbound, bind», for the account,
  the attempt and the directory the person confirmed. Two accounts confirming in two windows give
  exactly one winner; the other sees «another person's account».
- Before it, only sign-in and a minimal preview (folder, number of chats) are shown. No window,
  kept answer, return address, deep link, dialog, shortcut or live connection opens earlier work.
  bb starts some of these outside its main pages, so they are covered too.
- Cancel or a crash before the step leaves it unbound and closed; a crash after it never gives the
  work to another account.
- Lost access: the operator restores the **same** account id after checking the person; the same
  email address alone is not enough. A fully deleted account is not recreated by an ordinary
  sign-in: the directory stays closed until a checked restore or a move.
- Hand-over: the old service is stopped and the next person gets a **clean** directory. There is no
  «reset» that offers the old one again; moving chosen content is a separate permitted action. A
  separate macOS user protects files, but not from a local service that is still running.

### Session and block

28 days is the value we set in Supabase's session inactivity timeout, a Pro setting. Requirements:

- **One module** may renew: after a person's action, at most once an hour, over the network. It
  alone holds the refresh token and owns sign-in by Google and email, the code exchange, secure
  storage, renewal, the check and log-out. Supabase's library has two parts, and both are named: the
  module's own auth client, with automatic renewal off and the module's storage; and the client for
  data requests, created with the `accessToken` option, which only reads the token already issued
  and has no `auth` part of its own. In its default form the library renews an expired session for
  any request, whatever the timer setting, so the default form is not used.
- **The date** «signed in until» is set at the first sign-in and moves only after a confirmed
  renewal: 28 days from it, never past the admission's end date. A second click within the hour
  does not move it. It is applied at start, on waking, on use and while a window stays open.
- **Check**: at start and at an action when the last check is over an hour old. A network that
  answers is not a successful check; only the server's answer about this session is. After a long
  idle time the first action renews deliberately, and a confirmed ban is a refusal. What is
  promised: a block or log-out is noticed at the next successful check, and at the latest on the
  date. A window nobody touches may stay open until then. It closes a screen; running agents
  continue, in both variants of decision 7.
- **Reasons are told apart**: banned, session removed, token ended, network or server error. Only
  the first two are a refusal. A refusal and a log-out are stored with their reason, survive a
  restart, and win over a late renewal answer, also from a second window.
- **Log out of this Mac**: local sign-in is removed at once, with or without network, without
  renewing first. A sign-in already started in the browser is cancelled, so a late Google or email
  answer does not sign in again.
- **Log out on all devices**: «done» is shown only after the server confirmed it; the library
  reports success on 401, 403 and 404 and when this Mac has no session, so its result is not used
  as proof. With an ended token the module asks the person to sign in again first, or ends with a
  local log-out and a clear warning; it never renews silently. Otherwise: this Mac is signed out,
  and the app says that other devices may still be signed in and what to do.
- **Operator's functions**, on every call: signature, issuer and audience of the token, the
  operator's user id written at setup, second factor, a non-empty session id, the session still
  existing and not banned. If this cannot be checked, the call is refused. So an old token loses
  the list, disable and enable at once, before it ends.

| Situation              | With network                                                         | Without, or the cloud is down                        |
| ---------------------- | -------------------------------------------------------------------- | ---------------------------------------------------- |
| New person             | Signs in, if admitted                                                | Cannot start; the screen says why                    |
| Day 27                 | A use with a successful renewal moves the date                       | Works; shows how long is left                        |
| Day 28                 | Sign-in screen                                                       | Sign-in screen; files untouched; signs in afterwards |
| Account disabled       | Sign-in screen at the next successful check; a new sign-in, also one already started in the browser, is refused | At the next successful check, at the latest on the date |
| Enabled again          | A new sign-in; the old sessions stay ended                           | —                                                    |
| Admission ends         | No renewal or letter; sign-in screen at the next successful check    | On the end date, which the Mac already knows         |
| Log out on all devices | This Mac at once. «Done» and «others at their next check» only when the server confirmed it; otherwise the app says other devices may still be signed in. An ended token: sign in again first, or a local log-out with a warning | This Mac only, and the app says so |
| Plugin fails           | The kept answer decides until the date; a stored refusal stays       | Same                                                 |
| Mail provider is down  | Google works, email waits; signed-in people are not affected         | —                                                    |

The table is the proposal of decision 7. In its other variant, the «strict hour», the screen closes
an hour after the last successful check. Claude publishes 28 days for the web and immediate log-out
everywhere; other Macs here follow at their next check, and the client text gives 1ma's own times.

Accepted with a controlled clock: days 27, 28, 29; a second click after 30 minutes; a background
data request with an ended token renews nothing; a late renewal answer after log-out, across a
restart and from a second window; a late Google or email answer after log-out; global log-out
refused by the server is not «done»; an old token on the operator's functions after a revocation; a
block on day 2 found on the first action on day 5. Two Macs: one with a valid token, one on day 8
offline with an ended token and a valid local date; «everywhere» pressed on the second renews
nothing silently and shows no false «done»; confirmed revocation, unconfirmed revocation, network
failure and a block on the other Mac each have their own expected result. The other Mac shows the
refusal when it gets a definite refusal from the server, or on its local date. Also: removal from
the pilot, a temporary block, enabling again, and a Google callback before a block with the code
exchanged after it.

### Account service

Supabase CLI migrations in the private repository; `profiles`, `organizations`,
`memberships(role)` from the first one; explicit grants, RLS on each, tests that another user's and
another organization's rows are refused. The admin key stays in the service. The operator's recovery
is written down. Disabling asks for confirmation naming the client.

### Models

Each person signs in to Claude Code or Codex through the vendor's own flow with an own subscription
or key. 1ma has no Claude sign-in of its own, does not pool accounts, does not resell, and its cloud
never receives these credentials. bb's account-pool plugin is off by default and stays off. bb's Codex
provider reads its token on the Mac to show the remaining limit.

Anthropic's pages of 25.11.2026: third-party app usage draws from the person's plan, and a person may
sign in to the unmodified Claude Code; the developer page restricts products that offer plan limits
without approval, and the legal page ties Claude Code in a product to the Commercial Terms. Together
they do not settle whether 1ma may offer it. The operator decides after reading them; if it stays
unresolved, the agreed key is used. Text for the client: «1ma starts Anthropic's official program;
you sign in to it and pay Anthropic. Anthropic may change its terms or refuse the plan. 1ma never
switches you to paid use by itself.»

Before the first client, on a new **and** an updated installation:

- the edition of the terms the operator accepted is recorded;
- the official program is present on the Mac (bb may start without one); account-pool is off;
- **who pays is settled before the first request**, not seen after a task. 1ma's start checks, for
  the same program, environment and profile that bb will start: the method and organization reported
  by `claude auth status`; no key in the environment, no `apiKeyHelper`, no saved Console sign-in
  unless the key variant was agreed. A key outranks a plan, so the setup also applies Claude Code's
  own `forceLoginMethod` where it takes effect; its effect through bb is tested on a new and an
  updated Mac. On a mismatch a screen appears and no request is made. 1ma does not remove sign-in
  methods from the official program; it refuses to start it in the wrong mode. The check belongs to
  each actual start of an agent, also a later one from another project or after a change of mode.
  The stage 1 checks cover a plan, a saved Console sign-in, a key in the environment,
  `apiKeyHelper`, another profile, a company sign-in, a gateway and the cloud providers' modes, for
  which `forceLoginMethod` alone is not enough;
- after a separately permitted task the account's usage page (Settings → Usage for a plan, the
  Console for a key) is compared with the expected payer;
- a team's paid extra usage, if the client turned it on, is named in decision 4 as a payer;
- a refused sign-in shows a clear screen and starts no paid request;
- the key variant starts only after the client agreed on model, price and limit. Example: Sonnet 5.5
  costs $2 per million input and $10 per million output tokens, so 1 million in and 0.2 million out
  is $4 without cache; a month depends on the work.

### Personal tasks and earlier work

- `1ma-account`: public SDK only, own id.
- Personal tasks: bb's MIT `tasks` plugin is shipped but not installed. No code: the setup installs
  it, links the client's project, makes one preset, and gives a sample task to an agent.
- Same programs and the **same profile** on the same Mac keep their login, settings, skills,
  commands and MCP configuration; another profile (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`) does not, and
  1ma never opens a neighbouring one.
- **Chats are not imported by bb.** Community plugin `handoff` (MIT) gives the old text to the model
  only: not visible in the chat, costs the person's limit, cut at 150,000 characters.

**Check of 2–3 days, part of approval 1, on made-up chats** in four test profiles, without a client's
account. It answers: can old chats be read in 1ma with the vendors' own readers (Claude Agent SDK
`listSessions`, `getSessionMessages`; Codex app server `thread/list` with archived ones, then
`thread/turns/list` and `thread/items/list` page by page; `thread/read` gives metadata only), with
more than one profile, sending nothing; and can the work be continued by a separate button that
shows the amount and provider first and sends the text only after the person agrees. If `handoff` is
used for it, a pinned copy is audited first.

| Source             | See old chats | Continue | Settings | Limit    |
| ------------------ | ------------- | -------- | -------- | -------- |
| Claude Code        | to check      | to check | to check | to state |
| Codex CLI          | to check      | to check | to check | to state |
| Claude desktop app | to check      | to check | to check | to state |
| Codex desktop app  | to check      | to check | to check | to state |

Then decision 3: a first delivery **without** history, or exactly the sources and profiles that
passed. A client's own profile is looked at only after level 2 and with that person's consent.
Accepted per promised source: old messages visible, a cut shown, a second look makes no copy, looking
sends nothing, an unsupported profile or version gives an explanation. Chats of claude.ai and ChatGPT
in the cloud are not supported.

### Downloads and updates

Patch 0004 turns automatic installation off for **every** macOS build, so until it changes the Mac
app only announces a new version and it is installed by hand. Addresses in patches 0001 (Mac feed)
and 0009 (server updater) move to the download repository; links in 0017 by purpose; 0015 stays.
Each needs the owner's consent (decision 8a). The old channel stays with the last transition
version.

| Delivery                       | Checked before it                                                                                                                                                                        |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| First Mac, by hand (stage 1)   | The owner's signature over the build's hashes, checked by the manual procedure with a fingerprint received apart; the app's notice of a new version; the transition from the old channel |
| Mac by link, installing itself | Level 5, and patch 0004 removed for Apple-signed builds (decision 8a); then every rule below on the automatic way. A signed build given by link before that is level 5 and uses the manual check |
| Linux server (stage 2)         | Every rule below on every entrance of 0009, the manual one included; a fixed set of dependencies                                                                                         |

Requirements:

- **Who signs.** The release job builds, checks, and lists the hashes of every file of that build.
  The owner signs that list with the key from their password manager, outside the job; the job
  publishes it only if the signature fits. The channel's pointer is published last, only when every
  signed file is in place. No private key is ever in a repository or in automation; the job writes
  to the download repository with a right limited to it. Tool: an existing one (candidate
  `minisign`, ISC), not our own.
- **What is signed**: product, platform, architecture, channel, a release number that only grows,
  source commit, file hashes, and the term of the channel's pointer. The owner signs the pointer
  again before it ends; the job reminds them a week before.
- **Two keys with different powers**, both public parts in the app from the first signed build and
  in the first client's. The owner's main key signs releases; the reserve key only changes which keys
  are trusted, and its private part is kept by the owner apart from the main one. A release key
  cannot change trust. Trust changes are versioned on their own, come before the release number, and
  are checked before every installation, the first manual Mac included. The accepted version is kept
  on the Mac outside the app. The release-number barrier belongs to one set of trusted keys and starts
  again with a new set, so a higher number the thief published under the stolen key does not block an
  honest release under the new set. The scheme is an existing, reviewed one (in the manner of TUF),
  chosen in the implementation document, not invented. The fingerprint for a manual installation
  reaches the owner by a way of its own, not from the download place.
- **What recovery covers.** An installed app that already saw the thief's release, and one that missed
  the change of trust, both accept the new set once they get it. Until an app can get the current
  trust, from the download place or the second place named in the implementation document, it accepts
  no new package. A foreign package obtained before the change can no longer be installed after it. An
  installation over the same system keeps the newer trust; a clean installation from an old download
  starts from the trust built into it and gets the current one before any update. If foreign code
  has already run, nothing repairs itself: the owner's manual procedure restores a checked copy and
  checks the data separately.
- **Refused before anything is unpacked**: an unsigned, foreign or withdrawn key, a wrong channel or
  architecture, a pointer and package that do not match, a lower release number, the same number
  with other contents, a pointer past its term («could not confirm this is the latest»). The same
  rule for the automatic way, the button, the schedule, the command and the manual procedure. 0009
  is off in client builds, every entrance of it, until it does this.
- **Dependencies**: a signed server package does not prove what `npm install` later resolves; the
  Linux stage installs a fixed, checked set, and two installs of one build get the same set.
- **Going back** is a deliberate act: a new, higher release that says which data it can read, or the
  owner's written procedure with a copy, which checks the data and keeps the protection of later
  updates. After a failed or interrupted update the previous version, its data and plugins work.
  Going back across 0014–0016 says what stays and what does not return (built-in plugins, bb's
  account and Connect sign-ins).
- **Who missed the transition** has the manual procedure with the same check, and a trusted way
  offline to get the description and the fingerprint.
- A signature of ours says who made it; Apple's signing is separate and is level 5.
- An older installation loses bb's own account and Connect sign-ins at the update (patch 0016),
  and their old settings may be cleared; going back does not restore them. The person is told before.

Accepted for the first Mac by hand: old app → transition → next release with the old channel gone; a
skipped transition; an empty or half-filled download repository; each refusal above by the manual
way; a failed update; a clean Mac. Accepted
for the reserve key, before any client build is given out: a higher number signed only by the stolen
key, on an app that saw it and on one that missed the change of trust; an attempt to withdraw the
reserve with the stolen key; skipped releases; a replayed old pointer; an installation over the same
system and a clean one from an old download, with their different expected results; a foreign package
obtained before the change; the same number with other contents; a legitimate manual roll-back. The Linux and
automatic Mac lines are accepted in their own stages.

### Done when

On one clean Mac **and** one older installation, with made-up accounts, each with the expected result
written down beforehand, so that somebody who did not write the code can judge it: both sign-ins,
confirmed and cancelled; the four rows of «Admission»; binding with two windows and two accounts, a
crash before and after the step, a late callback or deep link; a handed-over Mac without the control
chat; two devices with block, admission end and both log-outs, a window open before the block, an
ended token; the operator's two second-factor cases and enabling again; a missing plugin; network and
cloud failures; export, deletion and restore; the first-Mac update lines and the reserve-key lines of
«Downloads and updates»; the payer settled before one task, which is then delegated and finished with
the personal tasks recipe, and a clear refusal without that setup; earlier chats only as decided.
Then level 2 in the card. On the test Mac the owner checks architecture, signature and the offline
screens. The server updater and automatic Mac installation are not part of it.

## Left for later

Named so that nobody waits for it in stage 1. Research done is kept here in short; each document is
approved on its own.

- **Gateway and its vendor** (stage 2). The owner's choice of 25.11 stays whole: the client turns it
  on, it works in any browser (the owner's words; the stage document may narrow this to named
  browsers only with the owner's confirmation), one 1ma gateway in the EU, only named fields are
  stored, and the absence of end-to-end encryption is said openly. The stage document shows that the
  gateway's operator, or an attacker on it, could reach content and live connections, and who ends
  open sessions. Prototypes: frp (Apache-2.0), with the design of bb's former `connect-next` (MIT; bb
  removed it upstream on 19.11.2026 in PR 7809, the pinned 0.49.0 still has it, so it is ours to keep
  or rebuild, not a bb feature to follow); Pangolin. Pangolin's AGPL
  Community and its Enterprise (free under $100,000 revenue, 25 users and 25 sites, key on
  request) differ; re-checking sessions is Cloud or Enterprise only and stores refresh tokens,
  more than agreed for Connect. The prototype names edition, licence holder and limits
- **Client's own Tailscale or Cloudflare** (stage 2). That client's choice, never replaces the
  gateway. Tailscale business $8 a person; a new network lets all reach all, so it counts only
  after a second employee was refused. Cloudflare: up to 50 free, may not be resold
- **Browser access** (stage 2). Off by default; one owner per server; only devices and sign-in
  times stored, more fields need consent; a planted text is found in no log, cache or terminal
  record; a removed device loses open connections in a time named beforehand; named browsers
- **Own server: pairing, updates, copies** (stage 2). How a server without a screen is tied to the
  account is tried before any estimate
- **Phone** (stage 2). After the browser. bb's app needs its sign-in, server list and session from
  our gateway. Test build first; then stores: Apple 4.8 and 4.2.7 (may exclude this way of
  working), deletion in the app and on the web; Google Play: a personal developer account created
  after 13.11.2023 needs a closed test with at least 12 testers for 14 days in a row before
  production, an organization's account is checked in the phone document; push off
- **Shared files** (stage 3). To try: Google Drive for teams on Macs (no Linux client), Syncthing
  (MPL-2.0) with servers. A separate folder with an owner; accepted after a deleted file and both
  sides of a conflict were recovered. A version history is not a backup
- **Shared board** (stage 3). Kaneo (MIT) and Paca (Apache-2.0) tried in thin connections
  **before** own tables. Example: two people, one gives a task to an agent in a closed 1ma, the
  colleague sees only the result; own field «urgency» survives an update. Paca's agent bridge
  sends replies, reasoning and tool calls to Paca, so only agreed card fields and the confirmed
  result may leave; Kaneo's author must be readable after update and restore. Removal ends
  requests at once and live connections in a named time. Planka and Multica are excluded for this
  way of delivery by licence; AGPL ones are possible with duties
- **Bots around the clock** (stage 2). An always-on machine with an API key, not a person's plan
- **Windows** (in parallel). Build and smoke check on a rented machine (to quote)
- **Closing the source** (owner's decision). Then: a home for git-installed plugins, and builds
  cost money (about $39 a week by the load of 18–25.11, a rough measure)

**Where a person's 1ma runs.** An agent has the rights of the operating-system account it runs under.
Own Mac: nothing to pay, no isolation from personal files, not around the clock. Another macOS user on
it: files apart, not the local service. A small server per person: both. One large server: cheaper, but
bb's local API has no sign-in, so people are separated only by real containers. Recommended: own Macs,
and a small server only for whoever needs isolation or work around the clock.

**How clients customize.** bb allows themes, new screens, panels, tools and settings through plugins an
agent writes, and calls to other plugins' functions. It does not allow a second plugin to add a field to
the first one's card; a fork works and gets no updates. So our own plugins are built to be extended:
declared custom fields (data an agent adds on request, survives updates), versioned functions, and a fork
for anything deeper. Plugin code is fully trusted by bb: clients install only what they trust. bb's
personal `tasks` has no custom fields and 1ma does not change it.

## Cost

Official pages, 25.11.2026, without tax; dollars and euros are not added together. Each purchase is
named with price and purpose beforehand; the owner buys. Nothing is needed for approval 1 except where
named.

| The owner, stage 1              | Price                                           | When                                                                                        |
| ------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Supabase Pro, one small project | $25 a month                                     | When the 28-day limit is tested, asked separately; before it, a Free project with test data |
| Second small project, for tests | About $10 a month (billed by the hour)          | Before the first client's data is in the first one                                          |
| Sign-in mail                    | $0 (Resend, 3,000 a month, 100 a day), then $20 | Before level 2; an EU provider: to quote (decision 6)                                       |
| Page and domain                 | To quote; an existing one if suitable           | Before Google's production setup                                                            |
| Accountant or lawyer            | To quote                                        | Before level 3                                                                              |
| Apple Developer Program         | $99 a year                                      | Level 5; the same membership serves the phone if it is the same team                        |
| Windows check, Windows signing  | To quote                                        | Before the order                                                                            |

Sums: **about $35 a month with the test project and Resend's free mail**, $25 without the test
project; $55 and $45 with Resend Pro ($20). The test project is recommended, and so is an EU mail
provider (decision 6): then about $35 plus its quote. Excluded: the rows «to quote» and use above the included limits.

| The agency of five, own Macs | Price (US price before tax; only if it needs these seats)                         |
| ---------------------------- | --------------------------------------------------------------------------------- |
| Claude Team Standard         | $125 a month, or $1,200 a year ($100 a month); not a new cost if it has the seats |
| 1ma                          | $0; services as ordered                                                           |
| Own key instead of seats     | By use, at the model's price (example in «Models»), with an agreed limit          |

| Later, separate orders | Price                                                                                                                                                                                                                                                                                                                                                                                                                                       | Payer  |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Gateway                | From €5.99 a month (Hetzner CX23 with IPv4, **not available to order** on the day); to quote                                                                                                                                                                                                                                                                                                                                                | Owner  |
| Server for one person  | €30–36 a month (CPX32), €17–20 (CPX22), **not available** on the day, shared processors; five CPX32: €152–180, five CPX22: €85–100; price confirmed before the order                                                                                                                                                                                                                                                                        | Client |
| One large server       | €111–130 (CPX62), after the container test, **not available** on the day; price confirmed before the order                                                                                                                                                                                                                                                                                                                                  | Client |
| Bot                    | A machine as above, and API use. An active Team in good standing gives $20 a Standard seat a month of API credit ($100 for five; $100 a Premium seat; pooled, at most $500 a month), seven days after the plan starts and once its owner links one Console organization (only support changes it), with the Claude and Console roles that needs; then requests stop unless the client buys credit or turns on automatic top-up; with an invoiced contract it is billed on | Client |
| Phone stores           | Google Play $25 once; Expo: free builds within limits, then from $19 a month plus use                                                                                                                                                                                                                                                                                                                                                       | Owner  |
| Board and files        | In their documents                                                                                                                                                                                                                                                                                                                                                                                                                          | —      |

## Time

| Part                        | Engineering (estimate)                                                                                                                | Waiting outside our control                                  |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Research (approval 1)       | About 1 week, with the 2–3 days for chats; runs beside the design system                                                              | Owner's choices                                              |
| Design system, first part   | 1–2 weeks                                                                                                                             | Owner's approval of the look                                 |
| Stage 1                     | About 3 weeks after these, with production setup of sign-in and mail; depends on decision 3 and is estimated again after the research | Operator's papers, Google, mail; company and Apple (level 5) |
| Connect                     | 1 week prototype, then 2–3 weeks                                                                                                      | Review                                                       |
| Server, phone, files, board | In their documents                                                                                                                    | Stores                                                       |

From approval 1 to a build that meets «Done when»: 4–5 weeks of engineering, without a fixed date,
if research and the design system run side by side. This replaces the earlier «a week» and «2–3
weeks». Google, the company, Apple and mail add their own waiting.

## Order of work

1. Approval 1, after the owner's explicit start. Test projects (Supabase Free, Google, test mail) and test identities the owner
   creates, $0; the paid 28-day test asked separately; prototypes and the check of chats on made-up
   data; design system.
2. The owner's choices from the results; screens and failures of stage 1; approval 2.
3. Page, domain, production Google and mail, in parallel with stage 1's code; download repository and
   keys.
4. «Done when»; the launch card; the case chosen in decision 2.

## Open decisions

Recommendation first; asked one at a time in plain words. Decision 1 was taken on 25.11 («Owner's
decisions»).

| #   | Question                        | Recommended                                                                                                                                                 | Otherwise                                                                                                                                                                        | Needed before                                     |
| --- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| 2   | First client before level 4     | Wait for the company: papers and data move once, but the date is not fixed                                                                                  | Free limited pilot by hand; or paid by hand after level 3. Either way no real data before level 2. Also: is a free installation by hand allowed after level 4 (recommended: yes) | Approval 2                                        |
| 3   | Earlier chats                   | Check first (approval 1), then the list of what passed                                                                                                      | First delivery without history                                                                                                                                                   | Approval 2                                        |
| 4   | Claude                          | Own plan after the checks, with the key's price agreed; the team's paid extra usage only if the client turned it on                                         | A key from the start; or ask Anthropic first, voluntarily                                                                                                                        | The promised mode: approval 2; its check: level 2 |
| 5   | Email                           | Code typed into the app, a proposed change                                                                                                                  | Link, as decided on 24.11                                                                                                                                                        | Screens of approval 2                             |
| 6   | Mail provider                   | One that stores in the EU, named with price after a check                                                                                                   | Resend (USA), stated in the policy                                                                                                                                               | Production mail                                   |
| 7   | Block                           | Noticed at the next check, as in the table                                                                                                                  | Strict hour: the app closes its screen an hour after the last successful check, so it does not work offline; extra work. Running agents continue in both                         | Approval 2                                        |
| 8a  | Update addresses and signatures | Change patches 0001, 0009, 0017 as above; keep 0004 until Apple signing, then remove it; the reserve key's private part kept by the owner in a second place | Stay on today's address; then no client release                                                                                                                                  | Work on the transition                            |
| 8b  | Region of accounts              | Frankfurt                                                                                                                                                   | Another named EU region                                                                                                                                                          | Production project                                |
| 8c  | Page and domain                 | An existing one if suitable                                                                                                                                 | A new one, price named                                                                                                                                                           | Production Google                                 |
| 9a  | Older documents                 | Short notes in those below                                                                                                                                  | Leave them                                                                                                                                                                       | Work that relies on them                          |
| 9b  | Parts of the earlier project    | Use after its holders' written permission                                                                                                                   | Build from Supabase's documented patterns                                                                                                                                        | Copying                                           |

## What this plan supersedes

| Text                                                                                 | Now                                                              |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| `docs/plan/2026-11-16-rebrand-stage-2-and-1ma-cloud.md`, «Облако 1ma»                | Replaced                                                         |
| `docs/plan/2026-10-31-1ma-desktop.md`: server sale, signing, models, languages, link | Where they differ, this document applies                         |
| `AGENTS.md` (bilingual), ADR-0003, ADR-0005 (Russian)                                | English only                                                     |
| ADR-0001 and the 31.10 plan (proposals to bb's authors)                              | Nothing is proposed to bb (13.11.2026)                           |
| ADR-0002, ADR-0004                                                                   | Public plugins unchanged; account service private; channel moves |

`docs/plan/2026-11-14-builtin-1ma-plugins.md` stays valid. Patch 0016 keeps bb's account and Connect
plugins out of 1ma; borrowing their design does not bring their connections back. Those files are not
edited in this change.

Licences: bb 0.49.0, `tasks`, `handoff`, termcanvas, dnd-kit, Kaneo: MIT. frp, Caddy, Paca: Apache-2.0.
Syncthing: MPL-2.0. minisign: ISC. The notices of a build are read from the built app before the first
client.

## Not verified

Supabase loopback sign-in, code mail, the three hooks and the ban in our settings (their order is read
from Supabase Auth's source, not run); linking of Google and email; `forceLoginMethod` and the payer
check through bb; the patch, the binding and the kept answer; which Anthropic terms apply to our build;
migration by running and the audit of `handoff`; the signing tool and the trust scheme; memory and
speed of any server (our own measurements: about 1 GB idle, 0.3–0.45 GB per Claude thread; Anthropic
asks for a machine with 4 GB or more, which is not a measure of Claude Code's own use); everything in
«Left for later».
