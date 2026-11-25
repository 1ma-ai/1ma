# 1ma cloud and teams

25.11.2026. Direction agreed with the owner topic by topic on 24–25.11.2026; choices still open
are in «Open decisions». Nothing here is built, bought or registered. Durations are estimates,
not promises.

## Two approvals

The owner can give them separately.

1. **Direction and research on made-up data.** This document's direction, prototypes of sign-in
   and of the required start, the check of earlier chats, the design system's first part. No real
   person's data, no client, no purchase that was not named beforehand.
2. **The first client release.** After the research: the choices in «Open decisions», the screens
   and failures of stage 1 in plain words, and the rule «Who may be given what». Product code for
   clients starts after this approval.

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

| Question                    | Answer                                                                                                                                               |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Which Macs                  | Each person's own. Chip, macOS version and the right to install are checked for all five before agreeing                                             |
| What is installed           | 1ma with personal tasks, Claude Code or Codex, by the owner together with the person                                                                 |
| Not in it                   | Shared chats, files or board, access from a browser or phone, work around the clock                                                                  |
| Who signs                   | The agency and the operator named in the private launch card. Free or paid: «Who may be given what»                                                  |
| What 1ma's cloud sees       | Name, email, time of sign-in and renewal, state of the account. Not chats, files, tasks or model keys                                                |
| What Claude or Codex sees   | What the person sends to it, under its terms                                                                                                         |
| The agency pays             | Its Claude seats to Anthropic ($125 a month for five, or $1,200 a year; nothing new if it has them), the services it ordered. The app is free        |
| The owner pays              | $35 a month in stage 1 (below), Apple $99 a year when builds are signed                                                                              |
| Claude refuses the plan     | A clear screen, no automatic paid request. The agency may choose its own key at the price and limit agreed before                                    |
| No network                  | Whoever is signed in continues until the date shown (28 days from the last renewal); the model itself needs the network. A new person cannot sign in |
| 1ma's cloud is down         | The same. Whoever reaches the date during the outage waits                                                                                           |
| An account is blocked       | The sign-in screen appears at the next check (below), at the latest on the date. Files stay. An agent that was already running continues             |
| A person leaves             | The agency's named contact asks; the operator disables the account. The Mac and files are the agency's                                               |
| Earlier chats do not arrive | They stay in Claude Code and Codex untouched. The agency knows which ones arrive before it agrees, or starts without them                            |
| A Mac goes to somebody else | Old 1ma is stopped; the next person gets a clean 1ma and does not see old chats. Moving chosen old content is a separate permitted step              |

bb has no users or roles: whoever reaches a server can act with the rights of the account it runs
under. Privacy between colleagues comes from each having their own 1ma. 1ma does not promise that
the app cannot be examined, that all data stays in the EU, or that nobody can technically see
Connect traffic.

## Owner's decisions

| Topic              | Decision                                                                                                                                                                                                        |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Income             | Services: training, rollout, setup. No payment system in the app                                                                                                                                                |
| Language           | English interface only                                                                                                                                                                                          |
| Order              | Personal app first, then Connect; company functions, the shared board last                                                                                                                                      |
| Board              | Free with 1ma, from open source; not a paid service. Later; personal tasks first                                                                                                                                |
| Integrations       | 1C, Directum and similar: outside these stages                                                                                                                                                                  |
| Computers          | Mac first, installed by the owner; Windows in parallel, checked on a rented machine, given to clients when stable                                                                                               |
| Apple Developer ID | Bought by the company when it takes over («Who may be given what»)                                                                                                                                              |
| Update signature   | «Менеджер паролей (Рекомендую)», 25.11: the owner creates the private key and keeps it in their password manager, no agent ever sees it; a second, reserve public key is in the app from the first signed build |
| Account            | Required at the first start; no client is installed before sign-in works                                                                                                                                        |
| Sign-in            | As Claude does it: Google or email, no passwords, 28 days renewed by use, «log out on all devices»                                                                                                              |
| Account disabled   | The app shows the sign-in screen; chats and files on the computer are not deleted                                                                                                                               |
| Cloud outage       | A client whose 28 days end during an outage waits; new people cannot sign in until it ends                                                                                                                      |
| Connect            | Stage 2. One 1ma gateway in the EU, stores devices and sign-in times, no end-to-end encryption (said openly)                                                                                                    |
| Team               | Own closed 1ma per employee; no shared chats or bots                                                                                                                                                            |
| Hosting            | Supabase in a named EU region                                                                                                                                                                                   |
| Account service    | Code in a separate private repository                                                                                                                                                                           |
| Downloads          | A separate public GitHub repository with builds only                                                                                                                                                            |
| Source             | Public during active development; closing it is decided later                                                                                                                                                   |
| Models             | Clients' own subscriptions, as the owner's, are preferred; the condition is open decision 4. No letter or lawyer is required for it                                                                             |

## Who may be given what

Levels 1 and 2 come first for everything; 3 to 5 are added by the case. The private **launch card** (not in this
repository) records for each client: the permitted case, the people admitted, who signs with the
client and with each supplier, in which role and from which date, who answers requests, and who
confirms the move to the company.

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
| Paid client after level 4                          | Levels 2, 3, 4. Unsigned only in person, as above; otherwise level 5                                                                    |
| Build sent by link, or installed by the client     | Level 5                                                                                                                                 |
| A stranger finds the download and tries to sign in | Refused, by Google and by email alike; no account is created and no letter is sent                                                      |

The last row is needed because Supabase creates a person at the first email sign-in unless told
otherwise. Its «before user created» hook (Free and Pro) checks the admitted list for both ways;
the email form checks it before asking for a letter and answers everybody the same.

**Data.** Named in the card: who does it, what it contains, format, term, stores. Accepted when:
one account is exported without anybody else's rows; it is deleted; a copy made before the
deletion is restored, compared and the deleted account removed again **before** the service opens.
Files on the person's Mac are theirs and are not touched by it.

| Data                            | Received by                 | Where                                      | Kept                                                                               |
| ------------------------------- | --------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------- |
| Account, sign-in times          | Supabase                    | EU region; logs' place and term to confirm | Until deletion; Pro's daily database copies 7 days, logs by their own terms        |
| Google sign-in                  | Google                      | Google's terms                             | Google's terms                                                                     |
| Sign-in mail                    | Mail provider (decision 6)  | Resend: USA                                | Resend: 30 days on its active plans, one letter cannot be deleted; others to check |
| Prompts and files for the model | The person's model provider | Its terms                                  | Its terms; not 1ma's cloud                                                         |

## Stage 1: account and the first client

### Design system first

It exists: bb ships shadcn/Radix components as vendored source (111 registry items, among them
calendar, table and command primitives), tokens in `theme.css`, light and dark. Plugins copy
components; a copy does not update itself. 1ma's theme plugin equals bb's default today.

A separate task with its own document and the owner's approval of the look, without a bb patch:
1ma values in `1ma-theme`; a 1ma registry of pinned bb items plus missing compositions (checked
one by one, such as date picker, multi-select, people picker); a usage guide that is also an agent
skill, because clients' agents build with it; a gallery plugin and a drift check. **First part**,
1–2 weeks: what sign-in, errors and the client list need. Accepted: gallery in both themes,
contrast checked, the owner approves the look.

### Sign-in

Reused: Supabase Auth and its documented patterns; `termcanvas` (MIT) as a pattern for a desktop
loopback; parts of the owner's earlier Supabase project only after its contributors' written
permission. Without it the first two suffice.

- Google: system browser, PKCE, one-time loopback address; the exchange happens in 1ma's own
  server process. This fits the Mac app; a remote server needs another way (stage 2).
- A published Google app needs a public page with a description and a privacy policy on a domain
  verified as ours; our terms are on it for clients. Test and production are separate Google
  projects.
- Email: «link» was decided on 24.11; a code typed into the app is recommended (decision 5):
  mail scanners open links, and a link works only in the place that asked for it.
- Google and email with the same verified address reach the same account. No codes or tokens in
  logs; Supabase's own rate limits and captcha.
- The client list is a tab in the owner's own 1ma: name, email, created, last sign-in or renewal,
  state.

### Required sign-in

A plugin's screen alone does not meet «required»: it shows nothing when the plugin fails, and an
installation that has finished bb's introduction skips a step placed there. So the decision is made
around the app's main pages at **every** start by a small bb patch, which needs the owner's consent
(decision 1) and is a condition of a client release. Adding the plugin also changes patch 0014 and
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

- One source of truth on the local server: unbound, or bound to a stable account id. «Signed in»
  and «may open this work» are separate states.
- Taking over is one conditional step on that server: «if still unbound, bind», for the account,
  the attempt and the directory the person confirmed. Two accounts confirming in two windows give
  exactly one winner; the other sees «another person's account».
- Before it, only sign-in and a minimal preview (folder, number of chats) are shown. No window,
  kept answer, return address, deep link, dialog, shortcut or live connection opens earlier work.
  bb starts some of these outside its main pages, so they are covered too.
- Cancel or a crash before the step leaves it unbound and closed; a crash after it never gives the
  work to another account.
- Lost access: the operator restores the **same** account id after checking the person; the same
  email address alone is not enough.
- Hand-over: the old service is stopped and the next person gets a **clean** directory. There is no
  «reset» that offers the old one again; moving chosen content is a separate permitted action. A
  separate macOS user protects files, but not from a local service that is still running.

### Session and block

28 days is Supabase's inactivity limit (Pro). Requirements:

- **One module** may renew: after a person's action, at most once an hour, over the network. It
  alone holds the refresh token. Other requests use the library's `accessToken` option with the
  token already issued, or stop when it ends; in its default form the library renews an expired
  session for any request, whatever the timer setting.
- **The date** «signed in until» is set at the first sign-in and moves only after a confirmed
  renewal: 28 days from it. A second click within the hour does not move it. It is applied at
  start, on waking, on use and while a window stays open.
- **Check**: at start and at an action when the last check is over an hour old. What is promised: a
  block or log-out is noticed at the next check with network, and at the latest on the date. A
  window nobody touches may stay open until then. It closes a screen; running agents continue.
- **Reasons are told apart**: banned, session removed, token ended, network or server error. Only
  the first two are a refusal. A refusal and a log-out are stored with their reason, survive a
  restart, and win over a late renewal answer, also from a second window.
- **Log out of this Mac**: local sign-in is removed at once, with or without network, without
  renewing first.
- **Log out on all devices**: «done» is shown only after the server confirmed it; the library
  reports success on 401, 403 and 404 and when this Mac has no session, so its result is not used
  as proof. Otherwise: this Mac is signed out, and the app says that other devices may still be
  signed in and what to do.
- **Operator's functions**, on every call: signature, issuer and audience of the token, the
  operator's user id written at setup, second factor, a non-empty session id, the session still
  existing and not banned. If this cannot be checked, the call is refused. So an old token loses
  the list, disable and enable at once, before it ends.

| Situation              | With network                                                         | Without, or the cloud is down                        |
| ---------------------- | -------------------------------------------------------------------- | ---------------------------------------------------- |
| New person             | Signs in, if admitted                                                | Cannot start; the screen says why                    |
| Day 27                 | A use with a successful renewal moves the date                       | Works; shows how long is left                        |
| Day 28                 | Sign-in screen                                                       | Sign-in screen; files untouched; signs in afterwards |
| Account disabled       | Sign-in screen at the next check; a new sign-in is refused           | At the next check, at the latest on the date         |
| Log out on all devices | This Mac at once, others at their next check; signing in again works | This Mac only, and the app says so                   |
| Plugin fails           | The kept answer decides until the date; a stored refusal stays       | Same                                                 |
| Mail provider is down  | Google works, email waits; signed-in people are not affected         | —                                                    |

The table is the proposal of decision 7. Claude publishes 28 days for the web and immediate log-out
everywhere; other Macs here follow at their next check, and the client text says so.

Accepted with a controlled clock: days 27, 28, 29; a second click after 30 minutes; a background
data request with an ended token renews nothing; a late renewal answer after log-out, across a
restart and from a second window; global log-out refused by the server is not «done»; two devices;
an old token on the operator's functions; a block on day 2 found on the first action on day 5.

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
- **who pays is seen, not assumed**: one task, then the account, organization and method shown by
  Claude Code (`/status`, `claude auth status`) and the usage in that account. A key in the
  environment outranks a plan, so the setup looks for one and uses Claude Code's own setting that
  refuses it (`forceLoginMethod`; its effect through bb is tested);
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
shows the amount and provider first.

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

Until Apple signing the Mac app only announces a new version and it is installed by hand. Addresses
in patches 0001 (Mac feed) and 0009 (server updater) move to the download repository; links in 0017
by purpose; 0015 stays. Each needs the owner's consent (decision 8). The old channel stays with the
last transition version. Requirements:

- **Who signs.** The release job builds, checks, and lists the hashes of what it checked. The owner
  signs that list with the key from their password manager, outside the job; the job publishes it
  only if the signature fits. No private key is ever in a repository or in automation. Tool: an
  existing one (candidate `minisign`, ISC), not our own.
- **What is signed**: product, platform, architecture, channel, a release number that only grows,
  source commit, file hashes, and the term of the channel's pointer, which the owner signs again
  before it ends.
- **Two public keys**, main and reserve, are in the app from the first signed build and in the first
  client's. Losing the main key: the reserve one signs, and installed apps accept it. A compromised
  key is withdrawn by a release signed with the other one. The fingerprint for a manual installation
  reaches the owner by a way of its own, not from the download place.
- **Refused before anything is unpacked**: an unsigned, foreign or withdrawn key, a wrong channel or
  architecture, a pointer and package that do not match, a lower release number, a pointer past its
  term («could not confirm this is the latest»). The same rule for the automatic way, the command and
  the manual procedure. 0009 is off in client builds, every entrance of it, until it does this.
- **Going back** is a deliberate act: a new, higher release that says which data it can read, or the
  owner's written procedure with a copy. After a failed update the previous version and its data work.
- **Who missed the transition** has the manual procedure with the same check.
- A signature of ours says who made it; Apple's signing is separate and is level 5.
- An older installation loses bb's own account and Connect sign-ins at the update (patch 0016); the
  person is told before.

Accepted: old app and old server → transition → next release with the old channel gone; a skipped
transition; each refusal above by the automatic and the manual way; the reserve key on an app already
given out; a failed update; a clean Mac.

### Done when

On one clean Mac **and** one older installation, with made-up accounts: both sign-ins; a stranger
refused; binding with two windows and two accounts; a handed-over Mac without the control chat; two
devices with block and both log-outs; plugin, network and cloud failures; export, deletion and
restore; the trusted update and each refusal; one task delegated and finished, with the payer seen;
earlier chats only as decided. Then level 2 in the card. On the test Mac the owner checks
architecture, signature and the offline screens.

## Left for later

Named so that nobody waits for it in stage 1. Research done is kept here in short; each document is
approved on its own.

- **Gateway and its vendor** (stage 2). Prototypes: bb's `connect-next` with frp (MIT, Apache-2.0;
  its entrance is internal, so a small patch or a change of our rule), Pangolin. Pangolin's AGPL
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
  working), deletion in the app and on the web, Google's 12 testers for 14 days; push off
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

| The owner, stage 1              | Price                                           | When                                                                      |
| ------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------- |
| Supabase Pro, one small project | $25 a month                                     | When the 28-day limit is tested; before it, a Free project with test data |
| Second small project, for tests | $10 a month                                     | Before the first client's data is in the first one                        |
| Sign-in mail                    | $0 (Resend, 3,000 a month, 100 a day), then $20 | Before level 2; an EU provider: to quote (decision 6)                     |
| Page and domain                 | To quote; an existing one if suitable           | Before Google's production setup                                          |
| Accountant or lawyer            | To quote                                        | Before level 3                                                            |
| Apple Developer Program         | $99 a year                                      | Level 5; the same membership serves the phone if it is the same team      |
| Windows check, Windows signing  | To quote                                        | Before the order                                                          |

Sums with Resend: **$35 a month with the test project** (recommended), $25 without it, plus $20 when the
free mail is not enough: $55 and $45. The EU mail provider's price is not in them. Excluded: the rows
«to quote».

| The agency of five, own Macs | Price                                                                             |
| ---------------------------- | --------------------------------------------------------------------------------- |
| Claude Team Standard         | $125 a month, or $1,200 a year ($100 a month); not a new cost if it has the seats |
| 1ma                          | $0; services as ordered                                                           |
| Own key instead of seats     | By use, at the model's price (example in «Models»), with an agreed limit          |

| Later, separate orders | Price                                                                                                                                                                                                                                                                                                      | Payer  |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Gateway                | From €5.99 a month (Hetzner CX23 with IPv4, **not available to order** on the day); to quote                                                                                                                                                                                                               | Owner  |
| Server for one person  | €30–36 a month (CPX32), €17–20 (CPX22), **not available** on the day, shared processors; five: €152–180                                                                                                                                                                                                    | Client |
| One large server       | €111–130 (CPX62), after the container test, **not available** on the day                                                                                                                                                                                                                                   | Client |
| Bot                    | A machine as above, and API use. Team Standard gives $20 a seat a month of API credit ($100 for five), seven days after the plan starts and once its owner links one Console organization (only support changes it); then requests stop unless credit is bought; with an invoiced contract it is billed on | Client |
| Phone stores           | Google Play $25 once; Expo: free builds within limits, then from $19 a month plus use                                                                                                                                                                                                                      | Owner  |
| Board and files        | In their documents                                                                                                                                                                                                                                                                                         | —      |

## Time

| Part                        | Engineering (estimate)                                                                                                                | Waiting outside our control                                  |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Research (approval 1)       | About 1 week, with the 2–3 days for chats; runs beside the design system                                                              | Owner's choices                                              |
| Design system, first part   | 1–2 weeks                                                                                                                             | Owner's approval of the look                                 |
| Stage 1                     | About 3 weeks after these, with production setup of sign-in and mail; depends on decision 3 and is estimated again after the research | Operator's papers, Google, mail; company and Apple (level 5) |
| Connect                     | 1 week prototype, then 2–3 weeks                                                                                                      | Review                                                       |
| Server, phone, files, board | In their documents                                                                                                                    | Stores                                                       |

From approval 1 to a build that meets «Done when»: 4–5 weeks of engineering, without a fixed date.

## Order of work

1. Approval 1. Test projects (Supabase, Google, mail) the owner creates; prototypes and the check of
   chats on made-up data; design system.
2. The owner's choices from the results; screens and failures of stage 1; approval 2.
3. Page, domain, production Google and mail, in parallel with stage 1's code; download repository and
   keys.
4. «Done when»; the launch card; the case chosen in decision 2.

## Open decisions

Recommendation first; asked one at a time in plain words.

| #   | Question                        | Recommended                                                                | Otherwise                                                                                                                | Needed before            |
| --- | ------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------ |
| 1   | Sign-in at every start          | A small bb patch                                                           | A weaker plugin screen, which changes «required» and is for the owner's trials only; or no client release until decided  | Approval 2               |
| 2   | First client before level 4     | Wait for the company: papers and data move once, but the date is not fixed | Free limited pilot by hand; or paid by hand after level 3. Either way no real data before level 2                        | Approval 2               |
| 3   | Earlier chats                   | Check first (approval 1), then the list of what passed                     | First delivery without history                                                                                           | Approval 2               |
| 4   | Claude                          | Own plan after the checks, with the key's price agreed                     | A key from the start; or ask Anthropic first                                                                             | Level 2                  |
| 5   | Email                           | Code typed into the app                                                    | Link, as decided on 24.11                                                                                                | Approval 2               |
| 6   | Mail provider                   | One that stores in the EU, named with price after a check                  | Resend (USA), stated in the policy                                                                                       | Production mail          |
| 7   | Block                           | Noticed at the next check, as in the table                                 | Strict hour: the app closes its screen after an hour without a successful check, so it does not work offline; extra work | Approval 2               |
| 8a  | Update addresses and signatures | Change patches 0001, 0009, 0017 as above                                   | Stay on today's address; then no client release                                                                          | Download repository      |
| 8b  | Region of accounts              | Frankfurt                                                                  | Another named EU region                                                                                                  | Production project       |
| 8c  | Page and domain                 | An existing one if suitable                                                | A new one, price named                                                                                                   | Production Google        |
| 9a  | Older documents                 | Short notes in those below                                                 | Leave them                                                                                                               | Work that relies on them |
| 9b  | Parts of the earlier project    | Use after its holders' written permission                                  | Build from Supabase's documented patterns                                                                                | Copying                  |

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

Supabase loopback sign-in, code mail, the hook and the ban in our settings; linking of Google and email;
`forceLoginMethod` through bb; the patch, the binding and the kept answer; which Anthropic terms apply to
our build; migration by running and the audit of `handoff`; the signing tool; memory and speed of any
server (our own measurements: about 1 GB idle, 0.3–0.45 GB per Claude thread; Anthropic names 4 GB for
Claude Code alone); everything in «Left for later».
