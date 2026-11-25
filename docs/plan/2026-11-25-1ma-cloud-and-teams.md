# 1ma cloud and teams

25.11.2026. Direction agreed with the owner topic by topic on 24–25.11.2026; choices
still open are in «Open decisions». Nothing here is built, bought or registered.
Implementation starts after the owner has approved every screen and failure of stage 1
in plain words. Durations are estimates, not promises.

## Rules

- **For whom**: solo entrepreneurs, people and small businesses. Enterprise needs
  (company single sign-on, custom roles, audit exports, admin consoles, certificates)
  come later and are not designed for now, except that people and companies share one
  data model from the start.
- **Small and without errors** beats large.
- **Nothing is invented.** Before each important task: research of best practice and
  free open source, with licence, activity and fit written down; then copy 1:1, or
  borrow the architecture, or say why neither works.
- **Free for the client.** Basic functions come with 1ma; the client does not buy a
  third-party service for them. They customize the rest themselves.
- **One design system.** Screens use only its components. A missing component is added
  to it first.

## What the customer gets

- **1ma app** on the person's own computer, or their own server (below). Chats and
  files are stored there. What the person sends to an agent goes to the model provider
  they chose.
- **1ma account**, required at the first start. One account per person; a person can
  belong to several companies.
- **Personal tasks**, with agents working on them. Shared tasks come later.
- **1ma Connect** (stage 2): the person opens their own 1ma from a browser, later from
  a phone. Off until switched on. The computer or server must be running.
- **Company workspace**: members, shared files and a shared board, later.

bb has no users or roles: whoever reaches a server can act with the rights of the
account it runs under. Privacy between colleagues comes from each having their own 1ma.
1ma does not promise that the app cannot be examined, that all data stays in the EU, or
that nobody can technically see Connect traffic.

## Owner's decisions

| Topic              | Decision                                                                                                          |
| ------------------ | ----------------------------------------------------------------------------------------------------------------- |
| Income             | Services: training, rollout, setup. No payment system in the app                                                  |
| Language           | English interface only                                                                                            |
| Order              | Personal app first, then Connect; company functions, the shared board last                                        |
| Board              | Free with 1ma, from open source; not a paid service. Later; personal tasks first                                  |
| Integrations       | 1C, Directum and similar: outside these stages                                                                    |
| Computers          | Mac first, installed by the owner; Windows in parallel, checked on a rented machine, given to clients when stable |
| Apple Developer ID | Bought later, when the operator's form is settled                                                                 |
| Account            | Required at the first start; no client is installed before sign-in works                                          |
| Sign-in            | As Claude does it: Google or email, no passwords, 28 days renewed by use, «log out on all devices»                |
| Account disabled   | The app shows the sign-in screen; chats and files on the computer are not deleted                                 |
| Cloud outage       | A client whose 28 days end during an outage waits; new people cannot sign in until it ends                        |
| Connect            | Stage 2. One 1ma gateway in the EU, stores devices and sign-in times, no end-to-end encryption (said openly)      |
| Team               | Own closed 1ma per employee; no shared chats or bots                                                              |
| Hosting            | Supabase in a named EU region                                                                                     |
| Account service    | Code in a separate private repository                                                                             |
| Downloads          | A separate public GitHub repository with builds only                                                              |
| Source             | Public during active development; closing it is decided later                                                     |
| Models             | Each client uses their own subscription, as the owner does                                                        |

## Models

Each person signs in to Claude Code or Codex through the vendor's own flow, with their
own subscription or key. 1ma has no Claude sign-in of its own, does not pool accounts and
does not resell usage. The 1ma cloud never receives these credentials. On the person's
machine they are used as the vendor's program stores them; bb's Codex provider also reads
its token there to show the remaining limit. bb's account-pool plugin, which would store
tokens, is off by default and stays off in the client's setup: direct provider mode.

Official pages on 25.11.2026: third-party app usage draws from the person's Claude
subscription limits, and a person may sign in to the unmodified Claude Code; another
page tells products built on the Agent SDK to use API keys unless approved. So it works
today and the rule can change. The same page ties offering Claude Code in a product to
Anthropic's Commercial Terms, whose applicable parts are read before the first client. No
letter or lawyer is a condition; the fallback is the client's own API key, written in the
client's setup guide.

| Company of five            | Claude                                                                                               |
| -------------------------- | ---------------------------------------------------------------------------------------------------- |
| Seats                      | Team plan: Standard $25 a month ($20 yearly), Premium $125 ($100), at least two; a limit per person  |
| Each employee signs in     | With their own seat, on their own computer or server. One seat is never shared                       |
| Bots and unattended agents | A Team plan adds API credits per seat ($20 Standard, $100 Premium, pooled up to $500) for an API key |
| OpenAI                     | Own ChatGPT plan; OpenAI asks automation to use an API key                                           |

Example of an unattended bot for five Standard seats: the plan's owner links one Claude
Console organization (it cannot be changed later without support); $100 of API credit a
month appears there; the bot's server holds that organization's API key. When the credit
ends, requests stop until next month unless the company buys credit or switches on
auto-reload: its choice, made at setup. Seat limits are not used by the bot.

## Where a person's 1ma runs

An agent has the rights of the operating-system account it runs under. Someone who
does not want it near personal files, or wants it to work around the clock, runs 1ma
elsewhere.

| Way                                | Isolation from personal files | Works 24/7 | Cost for five, month, without tax (Hetzner, 25.11) | Effort                          |
| ---------------------------------- | ----------------------------- | ---------- | -------------------------------------------------- | ------------------------------- |
| On the own Mac                     | No                            | No         | 0                                                  | None                            |
| Own Mac, separate macOS user       | Files of the other user only  | No         | 0                                                  | Switching users                 |
| **One small server per person**    | Yes                           | Yes        | 5 × 8 GB, €152–180 (CPX32); 4 GB €85–100 (CPX22)   | One setup recipe, five machines |
| One large server, a container each | Yes, if containers are right  | Yes        | 1 × 32 GB, €111–130 (CPX62); 16 GB €59–70 (CPX42)  | Admin, shared failure           |

Recommended: own Macs for those who need nothing more; a small server only for a person
who needs isolation or round-the-clock work. It is the same single-person product with
one's own credentials and copies, with its own memory and disk. The prices are for shared
processors (Helsinki to Germany), so speed under real work is measured, not promised. A
large server is cheaper but needs real container isolation: bb's local API has no
sign-in, so different operating-system users on one machine are **not** separated. Such
a server is a later variant (Incus or containers, one per person, no port shared).

Bots and always-on agents need an always-on machine: one small server for the company,
with an API key, not a person's subscription. bb's `automations` plugin runs schedules
on it today; schedules for `1ma-bots` are not in its first version. For a **person's**
own server, with their own seat: a one-year `claude setup-token` avoids sign-in expiry;
using Claude Code does not extend a normal login.

To build: a setup recipe (cloud-init, own service unit, updates, backup), the account's
servers added to the list bb and `1ma-server-switcher` already have (one server is shown
at a time), and a measurement. Our measurements, not a
promise: about 1 GB idle per server, 0.3–0.45 GB per running Claude thread. Anthropic
names 4 GB or more. Prices vary by place; Hetzner's page showed these
machines as not available to order on the day.

## Stage 1: account and the first client

Result: the owner installs 1ma on a client's Mac, the client signs in, the owner sees
them in a list, and the client's earlier work is there.

### Design system first

It exists: bb ships shadcn/Radix components as vendored source (a registry of about
110 items), tokens in `theme.css`, light and dark, and the capability components of the
SDK. Plugins copy components; a copy does not update itself. 1ma's theme plugin equals
bb's default today. Missing: cross-column drag, date picker, combobox, multi-select,
data table, file upload, people picker, settings layout.

The separate task, with its own document and owner's approval of the look, and no bb patch:

1. 1ma values in `1ma-theme` (light and dark, contrast checked).
2. A 1ma registry: pinned bb items plus the missing components as screens need them.
3. A usage guide that is also an agent skill: clients' agents build with it.
4. A gallery plugin for review and a check for drift from bb's items.

Stage 1 builds what the sign-in screen and the client list need.

### Sign-in

Reused: Supabase Auth, its documented patterns, an MIT example of a desktop loopback
sign-in (`termcanvas`) as a pattern, and parts of the owner's earlier
Supabase project: email-code flow, safe redirect handling, mail layer, row-security
hardening with attack-before/after tests. Contributors' written permission comes first;
that project has no licence file.

- **Google**: system browser, PKCE, a one-time loopback address; the exchange happens in
  1ma's own server process. This works when browser and server are the same machine,
  which is stage 1's Mac app. A remote server needs another way (stage 2).
- **Google's condition**: a published app needs a public page with a description, a privacy
  policy and terms on a domain verified as ours, also for sign-in only. One simple static
  page; its place and domain are named to the owner before anything is bought.
- **Email**: the owner decided «link» on 24.11. Changing it to a code typed into the app
  is an open decision, recommended: mail scanners open links, a PKCE link works only in the
  place that asked for it, and Supabase names a code as the fix. If the link stays: it
  opens a page with a button, works only on the Mac that asked, shows on another device
  what to do, and an expired or used link leads back to a new request.
- The client list is a tab in the owner's own 1ma.
- Supabase's own rate limits and captcha, no codes or tokens in logs, tokens in the
  operating system's secret storage or the plugin's server storage.
- Google after email with the same verified address reaches the same account.

### Required sign-in

A plugin overlay alone does not meet «required»: it is mounted under bb's own
introduction, and shows nothing when the plugin fails. A step in the introduction is not
enough either: an installation that finished it before accounts existed skips it. So the
decision is made around the app's main pages at **every** start, by a small bb patch (owner's
consent): the account plugin answers who is signed in and until when; the last answer is
kept in the data directory for when the plugin cannot answer. The sign-in return address
stays reachable. The plugin-only variant remains for the owner's own trials.

| At start                                | Shown                                                      |
| --------------------------------------- | ---------------------------------------------------------- |
| New installation                        | Sign-in, then bb's introduction                            |
| Earlier installation without an account | Sign-in, then a question to take over the work on this Mac |
| Valid answer, plugin works              | The app                                                    |
| Plugin fails, kept answer still valid   | The app, with a notice                                     |
| Plugin fails, no answer or it ended     | Error screen: retry, log, support text; files untouched    |
| Another person's account                | Explanation; the workspace stays closed                    |

**One installation, one person.** bb keeps all chats in one database, so a colleague who
signs in on a handed-over laptop would see them. The first account that signs in is written
into the data directory. Another account gets an explanation: return to the first account,
or use an own macOS user. Email and Google of the same verified address are the same
account. Handing a machine over on purpose is a documented manual step.

The registered list of patch 0014 changes (owner's consent). The screen controls the app we
ship and is not copy protection; files are protected by the operating-system account.
Checked: clean install and update, with the plugin healthy, missing and crashing; the same
person by both ways; a wrong account; a return with files in place.

### Session

Supabase's inactivity limit (Pro) is set to 28 days and counts token refreshes. The app
therefore refreshes the token only when a person acts in the window, at most hourly, and
never in the background or for an agent; the library's automatic refresh is off. The app
stores «signed in until» = last successful refresh + 28 days and applies it at start, on
waking, on use and while an open window passes it. Supabase itself may accept a token up to
one token life longer.

| Situation                    | Online                                                                                                              | No network, or the cloud is down                     |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| New person                   | Signs in                                                                                                            | Cannot start; the screen says why                    |
| Day 27 since use             | Any use renews                                                                                                      | Works; shows how long is left                        |
| Day 28 reached               | Sign-in screen                                                                                                      | Sign-in screen; files untouched                      |
| After the outage             | Signs in and continues                                                                                              | —                                                    |
| Mail provider down           | Google works, email waits; signed-in people are not affected                                                        | —                                                    |
| Account disabled             | Definite refusal → sign-in screen, which refuses too; at the next refresh: next start or use, at most an hour later | Noticed at the next connection, at the latest day 28 |
| «Log out on all devices»     | Other devices: sign-in screen at their next refresh; a new sign-in works at once                                    | Noticed at the next connection, at the latest day 28 |
| Account plugin fails         | The kept answer decides until day 28 (above); a disabled account is then noticed only when the plugin works again   | Same                                                 |
| Network error during refresh | Not a refusal: works until day 28                                                                                   | Same                                                 |

Disabling uses Supabase's own ban, through a function that only the operator can call.
Revoking one device separately is added with Connect. An already issued token stays
valid until it ends (minutes to an hour); stage 1 has no cloud function that needs more.
Locking shows a screen: no agent is stopped, nothing is deleted.

Tests with a controlled clock: days 27, 28, 29; a window open and idle past day 28;
background work without use; two devices with global log-out, where a new sign-in works and
a disabled account's does not; recovery after an outage.

### Account service

Supabase CLI migrations in the private repository. Tables for people and companies from
the first one: `profiles`, `organizations`, `memberships(role)`; explicit grants, RLS on
each, and tests that another user's and another organization's rows are refused. Account
deletion and export.

Client list, disable and enable are functions of this service; the admin key stays there,
because it bypasses row security. Each call requires **both** the operator's user id,
written into the service at setup, and a session confirmed with a second factor; anyone can
enrol a second factor, so it alone proves nothing. The operator enrols it once; its
recovery is written down. The list shows name, email, created, last use, state; disabling
asks for confirmation naming the client. Tests: an ordinary user with a second factor and
the operator without it are refused.

### Plugins and migration of earlier work

- `1ma-account`: public SDK only, own id. bb's `bb-account` shows the flow; it speaks to
  bb's service.
- **Personal tasks**: bb's MIT `tasks` plugin is shipped but not installed. It has a
  board and a list, priority, due date, labels, comments and agents working on a task.
  No code; the setup recipe installs it, links the client's project, makes one preset with
  their signed-in provider and model, and gives a sample task to an agent. Without the link
  and the preset delegation is refused.
- **Migration from Claude Code and Codex**. Already shared, because 1ma drives the same
  installed programs: login, settings, skills, commands, MCP configuration and
  `CLAUDE.md`/`AGENTS.md` (part of it read in code, not run). Projects are found by the
  introduction. **Chats are not imported by bb.** Community plugin `handoff` (MIT) reads
  Claude Code, Codex, Gemini, OpenCode and Pi sessions and starts a new thread, but gives the
  old text only to the model: the person does not see it in the chat, starting costs their
  limit, and it is cut at 150,000 characters by default. That alone is not «my chats arrived».

  Plan, a check of 2–3 days before any estimate: read-only finding and preview of earlier
  chats with the vendors' own readers (the Claude Agent SDK has `listSessions` and
  `getSessionMessages`; Codex's to be found), so that old messages can be **read** in 1ma
  without a model; «continue with Claude/Codex» as a separate button, from an audited,
  pinned copy of `handoff`; a native continuation (both programs can resume a session by id)
  only if it needs no more than a small bb change, offered to the owner separately. Folders,
  MCP and settings are listed with what moved and what did not.

  Accepted on one real conversation from each promised source (Claude Code, Codex, and their
  desktop apps if the check finds their files): old messages visible, a cut is shown, a second
  import makes no copy. Chats of claude.ai and ChatGPT in the cloud: not supported.

### Downloads and updates

Today's Macs are replaced by hand, so publishing a build does not move them.

- Checks of the build and its commit stay in the source repository. The release tag there
  stays; the download repository gets its own tag on its own commit, because a source commit
  does not exist in it. A signed manifest carries the source commit and file hashes.
- The release job writes to the download repository with a right limited to it.
- The old channel stays with the last transition version; a written manual procedure
  covers those that missed it. The source is not closed because a build was published.
- Addresses in patches 0001 and 0009 change. Patch 0015 states where plugins come from
  and is not pointed at the download repository. In 0017 links are set by purpose.
  Consent of the owner.
- Before clients: the manifest is signed with a key that is not in the download repository,
  and the owner's install and update procedure checks it (today the file and its checksum
  come from the same place). Apple signing covers the Mac later. Apple Silicon only at
  first; managed Macs may forbid unsigned apps.
- Clients receive built-in plugins. Plugins installed from this repository by git need a
  home if it closes.

Tests: old app → transition → next release with the old channel unavailable; a clean
Mac; a skipped transition; an empty download repository; a changed file is refused.

### Data

The minimum the law asks of anyone holding accounts, in plain words for the client:
privacy policy and terms, the providers' standard processing agreements, deletion and
export, a named contact, a restore from copy tried once. Who the contracting party is and
how it changes later is decided by the owner and not repeated here. Open is only the
confirmation that paid work and moving contracts are possible that way: from an accountant
or lawyer, before paid work, not before building. Enterprise paperwork is out.

| Data                            | Received by                   | Where                                     | Kept                          |
| ------------------------------- | ----------------------------- | ----------------------------------------- | ----------------------------- |
| Account, sign-in times          | Supabase                      | EU region; logs place to confirm          | Until deletion; copies 7 days |
| Google sign-in                  | Google                        | Google's terms                            | Google's terms                |
| Sign-in mail                    | Mail provider (open decision) | Resend stores content and logs in the USA | Its contract                  |
| Prompts and files for the model | The person's model provider   | Its terms                                 | Its terms; not 1ma's cloud    |
| Connect traffic (stage 2)       | Gateway host                  | EU                                        | Not stored                    |
| Push (off in the first version) | Expo, Apple, Google           | Includes the USA                          | —                             |

### Done when

On a clean Mac the owner sees: both sign-ins, the client in the list, disabling and
return, log-out everywhere, the outage screens, an update that keeps data, a restore, one
delegated task with the client's own subscription, a wrong account refused, and earlier
chats and settings as accepted above.

## Stage 2: Connect, servers, phone

### Transport

Research before code; the first task is a prototype of page loads, files, live
WebSocket and terminal, with a load measurement.

| Candidate                                 | For                                            | Against                                                                                                                                     |
| ----------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| bb's `connect-next` gate with frp         | MIT and Apache-2.0, written for this product   | Uses an internal entrance; GitHub sign-in and control service to be replaced                                                                |
| Pangolin Community (self-hosted)          | Ready gateway with sign-in, 24k stars          | AGPL and commercial parts; its FAQ puts outside sign-in into paid plans, the code has a global one; WebSocket and many clients not verified |
| The client's own Tailscale                | Nothing to build or run; no traffic through us | Business use is $8 per person a month (the free plan is non-commercial)                                                                     |
| The client's own Cloudflare Tunnel+Access | Up to 50 users free, WebSocket                 | Setup by the client; reselling one account to clients is forbidden                                                                          |

Recommended: prototype `connect-next` and Pangolin; keep the agreed own gateway. The
client's Tailscale is a documented workaround for those who need it earlier, with one
condition: a new company network lets everyone reach everything, and bb's API has no
sign-in, so colleagues would reach each other's chats and files. Each person gets a private
network or a rule «only the owner», and it counts only after a second employee was refused.
Pangolin's prototype starts with one outside sign-in, two people, two servers and removal
on the free edition; its licence result is written down first. An own
control service is written only for what neither offers. bb exposes its entrance only
as `internal_DO_NOT_USE_openTunnelIngress`; using it breaks our rule unless the owner
changes it, so the alternative is a small bb patch.

### Browser access

- Off by default; a visible switch and state.
- One owner per server; another account is refused, tested in our gateway.
- TLS both sides; it ends at the gateway, so its controller can read content and act as
  the client. Client text says so. One compromised gateway concerns all its clients.
- Stored: devices and sign-in times. Account and server ids and a short security log with
  a fixed term are proposed and need the owner's agreement. Stock logs and caches of the
  gate, Caddy, frp and the machine are cut to agreed fields.
- A separate machine, keys outside the repository, review before the first Connect user.
- Browsers are named after testing.

Done when: a foreign account, a disabled account and a removed device are refused, also
on open connections within the agreed time; gateway loss is clear and recovers; local
work continues; a planted chat text and path are found in no log; each named browser works.

### Own server and phone

Own server: the recipe above, so the app and the browser reach it through the same
Connect. Before it is estimated: how a fresh server without a screen is bound to the account
the person is already signed in to (pairing, or a return through the gateway), tried from
another device. Phone: a **test build** for the owner (own identifiers, pairing through our
service, no bb domains); a **store release** separately: Apple's rule 4.8 on an
equivalent private login, account deletion in the app, reviewer access; a new personal
Google Play account needs 12 testers for 14 days. Push is off in the first version.

## Stage 3: company functions

Each starts with its own research document and the owner's approval.

### Shared files

| Way                       | For                                         | Against                                                                    |
| ------------------------- | ------------------------------------------- | -------------------------------------------------------------------------- |
| Google Drive (desktop)    | Simple, on accounts most teams already have | No Linux client, so it does not fit servers; Workspace from €6.80 a person |
| Syncthing (MPL-2.0)       | Free, plain files, Mac, Linux, Windows      | Machines must be online together; a server fixes that; no roles            |
| Private GitHub repository | History, merges                             | For technical people                                                       |
| Nextcloud (AGPL)          | Own hosting, rights                         | Needs a server and care                                                    |

Recommended to test: Google Drive for teams on Macs; Syncthing when people use servers or
want no Google. Proposed checks, none done yet: many small writes by agents, simultaneous
edits, offline. Either way a separate working folder with a named owner, because an agent's
mistaken deletion reaches everyone: Drive's files pinned offline where needed (shared drives
are only streamed), Syncthing's versions switched on at one receiving machine (off by
default) or an existing backup. Accepted after a deleted file and both versions of a
conflicting edit were recovered. A
folder on a shared server is not a first choice, because it needs accounts and rights.

### Shared board

Plugin of 1ma, free, data in the 1ma cloud. Research on 25.11, licence and activity
checked: **Kaneo** (MIT, 9.9k stars) has columns, custom fields, REST, webhooks, live
updates and 40 agent tools, but its own users, no author in the task's row (the creation
event names one) and no agent identity; **Paca**
(Apache-2.0) treats people and agents as equal accounts. Excluded by licence: Multica,
Planka. Vikunja, Plane, Kan and Leantime are AGPL. Kanboard is in maintenance, Vibe
Kanban is closing.

Acceptance example, from the owner's decision: two people; columns, assignee, author, due
date, comments, «my tasks»; one gives a task to an agent in their closed 1ma, the colleague
sees only the result on the card; the company's own field «urgency» survives an update.
Roles: administrator and member. The stage's document tries a thin connection to Kaneo and
to Paca against this example before own tables are decided.

Current preference: tables and agent-tool shapes borrowed from Kaneo, account kinds from Paca,
UI on our components (dnd-kit, MIT), on our Supabase. Running Kaneo itself would add a
second user database, a beta sign-in bridge and a service to update; it wins if
attachments, webhooks, Gantt or recurrence are soon needed. Either way, notices are kept.

Rules: server-side origin of every record; an agent gets a short right for one task;
removal ends requests at once and open connections within the token's life; live changes
over Broadcast; publishing to a card is giving text to colleagues. Also in scope of this
stage: invitations and members.

### How clients customize

What bb allows: look through a theme; new screens, panels, tools, settings through
plugins an agent writes (`bb plugin new`, `install`, `dev`, with a skill); calling
another plugin's functions. **It does not allow** a second plugin to add a field to the
first one's card: a plugin cannot offer slots to others, a built-in's id cannot be
replaced, edits of a built-in are lost on update. A fork works (the client owns it as a
local plugin and receives no updates).

So our own plugins are built to be extended, as part of their contract:

1. **Declared custom fields**: a definition table (name, type, label, options) and
   values, shown on the card, details, filters, agent tools. Adding «urgency» is data an
   agent creates on request; no code, survives updates.
2. Versioned functions for other plugins.
3. Everything deeper: a fork under a new id, as bb supports.

Anyone's plugin code is fully trusted by bb, without a sandbox: clients install only what
they trust. The personal `tasks` plugin has priority, labels and due dates, but no custom
fields; 1ma does not change it.

## Cost

Official pages, 25.11.2026, without tax; dollars and euros are not added together. Each
purchase is named with price and purpose beforehand.

| Item                           | Price                                                                        |
| ------------------------------ | ---------------------------------------------------------------------------- |
| Supabase Pro                   | from $25 a month                                                             |
| Sign-in mail                   | $0 (Resend free: 3,000 a month, 100 a day), then $20; EU providers rechecked |
| Public page for Google sign-in | $0 hosting possible; a domain if a new one is needed, to quote               |
| **Stage 1**                    | **$25–45 a month**, plus quotes not yet made: accountant or lawyer           |
| Gateway, from stage 2          | from €5.99 (Hetzner CX23 with IPv4); real size after measuring               |
| Apple Developer / Google Play  | $99 a year / $25 once                                                        |
| Windows signing                | from €209; term and tax to confirm                                           |
| Client pays                    | Own Claude or ChatGPT plan; own server only if wanted                        |

If the source is closed, builds cost money: 18–25.11.2026, about 5,200 Linux and 126
macOS minutes by job durations, roughly $39 a week; a rough measure, not a limit. $12 a
month is an included allowance.

## Time

| Part                      | Engineering (estimate)                                                                                 | Waiting outside our control                   |
| ------------------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------- |
| Design system, first part | 1–2 weeks, own document                                                                                | Owner's approval of the look                  |
| Stage 1                   | about 3 weeks after it, together 4–5; re-estimated after the sign-in prototype and the migration check | Accountant, mail and Google accounts          |
| Windows, in parallel      | not estimated; first a build and a smoke check on a rented machine (to quote); to clients when stable  | Windows signing                               |
| Connect                   | 1 week prototype, then 2–3 weeks                                                                       | Review                                        |
| Server recipe             | about 1 week                                                                                           | —                                             |
| Phone                     | 1–2 weeks test build; stores not estimated                                                             | Store review, 14 days on a new Google account |
| Files, board              | estimated in their documents                                                                           | —                                             |

## Components and licences

| Component                                                 | Licence                                   |
| --------------------------------------------------------- | ----------------------------------------- |
| bb 0.49.0, `tasks`, `handoff`, termcanvas, dnd-kit, Kaneo | MIT                                       |
| frp 0.71.0, Caddy, Paca                                   | Apache-2.0                                |
| Syncthing                                                 | MPL-2.0                                   |
| Pangolin                                                  | AGPL and commercial parts, only if chosen |
| Parts of the owner's earlier project                      | No licence file: written permission       |

Every build the client receives lists its notice files; the list is read from the built
app before the first client.

## Open decisions

Recommendation first; asked one at a time in plain words.

1. **Sign-in step**: a small bb patch at every start (0014's list included), or a weaker
   plugin-only screen, which changes the earlier decision «required».
2. **Email**: a code typed into the app, or a link.
3. **First client**: a free limited pilot, then paid after the party is confirmed and the
   app is signed; or paid at once if confirmed; or wait for signing.
4. **Mail**: storing data in the EU, or Resend in the USA, stated in the policy.
5. **Patches** 0001, 0009, 0017. **Region**: Frankfurt, if no reason against. **Page** for
   Google: place and domain.
6. **Older documents**: permission to update those below; **reuse** of the earlier
   project's parts (written permission).

Before the server recipe: one small server per person who needs it (recommended). Before
Connect: transport, extra stored fields, revocation time. Before the phone: test
build or stores, iOS sign-in, push. Before files and board: their documents.

## What this plan supersedes

| Text                                                                                 | Now                                                              |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| `docs/plan/2026-11-16-rebrand-stage-2-and-1ma-cloud.md`, «Облако 1ma»                | Replaced                                                         |
| `docs/plan/2026-10-31-1ma-desktop.md`: server sale, signing, models, languages, link | Where they differ, this document applies                         |
| `AGENTS.md` (bilingual), ADR-0003, ADR-0005 (Russian)                                | English only                                                     |
| ADR-0001 and the 31.10 plan (proposals to bb's authors)                              | Nothing is proposed to bb (13.11.2026)                           |
| ADR-0002, ADR-0004                                                                   | Public plugins unchanged; account service private; channel moves |

Those files are not edited in this change; a follow-up marks them after consent.

## Not verified

- Supabase loopback sign-in and code mail end to end; the ban's effect on refresh in our
  settings; linking of Google and email.
- Plugin and migration behaviour by running; `handoff` audit; the same for Claude's and
  Codex's desktop-app chats.
- The patch at every start and the kept answer; the applicable Anthropic terms.
- Transport candidates; browsers; memory per client; containers on one machine.
- Google Drive and Syncthing with agents; what a Mac-app switch between two servers does.
- What Claude's desktop app does offline: not documented officially.
- On a test Mac by the owner: architecture and signature of a build, old update channel,
  order of introduction and sign-in, offline screens.

## Order of work after approval

1. Owner: choices 1–6; stage 1 screens and failures approved in plain words.
2. Design system, first part; prototype of sign-in and the migration check; then stage 1.
   Windows in parallel.
3. Owner's check on a clean Mac, then the first client. Later stages get own documents.
