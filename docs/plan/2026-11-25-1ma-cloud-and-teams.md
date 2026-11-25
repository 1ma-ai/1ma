# 1ma cloud and teams

25.11.2026. Plan agreed with the owner topic by topic on 24–25.11.2026. It
replaces the section «Облако 1ma» of
[2026-11-16-rebrand-stage-2-and-1ma-cloud.md](2026-11-16-rebrand-stage-2-and-1ma-cloud.md).
Nothing here is built, bought or registered yet. Durations are estimates, not
promises.

## What the customer gets

One product for people and for companies:

- **1ma app** on the person's own computer. Chats, files and agents stay there.
- **1ma account**, required at the first start. One account per person; a person
  can belong to several companies.
- **1ma Connect** (stage 2): the person opens their own 1ma from a browser or a
  phone. Off until they switch it on. Their computer must be running.
- **Company workspace** (stage 3): members and a shared task board in the 1ma
  cloud, shown as a tab in each member's app.

There is no shared bb server in this plan. bb has no users or roles: whoever
reaches a server can read every chat, file and stored secret on it and run
commands. Privacy between colleagues therefore comes from each having their own
1ma. Hosting an employee's 1ma on a company server can be added later.

## Owner's decisions

| Topic               | Decision                                                                                                                            |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Order               | Personal app first; companies are designed in from the start and built as a later task                                              |
| Payment             | No payment system in the app for now                                                                                                |
| Computers           | Mac first; the Windows build starts in parallel, is checked on a rented machine and is given to clients when stable                 |
| Account             | Required at the first start; no client is installed before sign-in works                                                            |
| Sign-in             | Exactly as Claude does it: Google or an email link, no passwords, 28 days renewed by use, «log out on all devices»                  |
| Account disabled    | The app shows the sign-in screen; chats and files on the computer are not deleted                                                   |
| Cloud outage        | As Claude: a client whose 28 days end during an outage waits for the fix. A variant that never locks signed-in clients was declined |
| Access from outside | Second stage                                                                                                                        |
| Connect             | One 1ma gateway in the EU for all clients, stores no traffic, no end-to-end encryption (told to clients openly)                     |
| Team                | Own closed 1ma per employee, on the employee's computer, plus a shared board                                                        |
| Board               | People and their agents; roles: administrator and member                                                                            |
| Hosting             | Supabase in a named EU region for accounts, client list and boards                                                                  |
| Downloads           | A separate public repository with builds only                                                                                       |
| Source              | This repository stays public during active development; closing it is decided later, checks then probably run locally               |

## Models

Each person uses their own Claude or ChatGPT subscription or API key. Anthropic's
terms require each end user to authenticate with their own credential, keep
Claude Code unmodified, and forbid reselling or intermediating its usage.
Preinstalling or running Claude Code inside a product needs Anthropic's Commercial
Terms: 1ma keeps letting the user install it, and whether that is enough is checked
with a lawyer before the first client.

## Stage 1: account and the first client (2–3 weeks)

Result: the owner installs 1ma on a client's Mac, the client signs in, and the
owner sees them in a client list.

1. **Account service** on Supabase: sign-in by Google and email link through an
   own mail provider, 28-day inactivity limit (a Pro feature), log out everywhere,
   account deletion and data export.
2. **Data model for people and companies from the first migration**:
   `profiles`, `organizations`, `memberships(role)`, `devices`. Row-level security
   on every table, with tests that another user's and another organization's rows
   are refused.
3. **Sign-in page and client list** on the account address. The owner's list can
   disable an account. The administrator is a role in the database, never a
   check in the page.
4. **Plugin `1ma-account`**, built in: opens the sign-in page in the browser,
   finishes with a device code (bb's removed `bb-account` plugin is the model),
   keeps tokens in the plugin's server-side secret store, and covers the app until
   signed in.
5. **Download repository** with builds and update files. A release that points the
   app and the server at the new address goes out before the first client, because
   the addresses are compiled in (patches 0001 and 0009; 0015 and 0017 also name
   this repository). Otherwise installed copies stop updating when the source is
   closed. This changes existing patches, so it needs the owner's consent.

What the sign-in screen is not: it counts clients and does not prevent copying.

- `experimental_appOverlay` mounts inside `AppLayout`, under `OnboardingGate`
  (`apps/app/src/App.tsx`), so sign-in comes after bb's own introduction.
- If the plugin crashes or is switched off, the app opens without the screen.
- The local API stays unauthenticated, as in bb.

A sign-in step that is first and cannot be switched off needs a bb patch. The plan
uses the plugin; the patch is offered when the owner redoes the introduction.

Without Apple signing the first start is allowed in macOS settings, and updates on
the Mac are installed by hand.

**Required before the first client**: a named legal operator of the service,
privacy policy and terms reviewed by a lawyer, data processing agreements with
Supabase and the mail provider, a check that services may be invoiced, an incident
contact, a restore from backup performed once, and an independent security review.

## Stage 2: 1ma Connect, then the phone

### Browser access (2–3 weeks)

- Base: bb's `apps/connect-next` gate and frps (MIT) on an EU server behind Caddy.
  Sign-in uses the 1ma account; bb's GitHub-only account API is replaced.
- Each device has its own key, revocable from the account. Machine access uses the
  public `experimental_serverAccess` API.
- Passes through the gateway: chats, opened files, commands. Stored: account and
  server ids, devices, sign-in times, security log with a fixed retention.
- TLS ends at the gateway, so whoever controls it could read traffic and act as a
  client. Hence: off by default, no request logging, separate machine with nothing
  else on it, signing keys outside the repository, independent review before the
  first client.
- A personal server has one owner; another account gets 403. This is kept.

Decision before this stage: the tunnel entrance in bb is
`internal_DO_NOT_USE_openTunnelIngress`, which our «public SDK only» rule forbids.
The choices are an exception for this plugin, a small bb patch, or a relay plugin
through the public WebSocket routes, whose behaviour is not tested. Recommended:
test the relay first.

### Phone (1–2 more weeks)

bb's Expo app renamed, signing in through the 1ma gateway. Needs own Apple and
Google accounts and an Expo project. Push goes through Expo in the USA: thread
titles are left out of the push text, or push stays off, until the privacy policy
covers it. Store review time is unknown.

## Stage 3: company workspace and board (3–4 weeks)

- Invitations by email; roles administrator and member, enforced by the database.
  Unlike anything inside bb, these limits are real: the board is a separate
  service and every request carries the member's own session.
- Board: columns, assignee, author, priority, due date, labels, sub-tasks,
  comments, activity history, «my tasks», live updates, revision check on edits.
- Plugin `1ma-board`: UI parts from a copy of bb's MIT `tasks` plugin with
  `UPSTREAM.md`; data from the cloud instead of local SQLite.
- A member hands their task to an agent in their own 1ma. The agent moves the card
  and writes the result under that member's name, marked as an agent. Colleagues
  see the card, never the chat.
- An agent can read its owner's session on that computer, so it can act as that
  member and as nobody else.

Not in this stage: shared chats and bots, private chats with enforced rights
inside one server (needs a change of bb's core), guests, custom columns, company
single sign-on.

## Cost

Prices checked on official pages on 24–25.11.2026 unless marked. The owner opens
accounts, pays and enters credentials; each purchase is named again beforehand.

| When      | Service                             | Price                                                                      |
| --------- | ----------------------------------- | -------------------------------------------------------------------------- |
| Stage 1   | Supabase Pro                        | from $25/month                                                             |
| Stage 1   | Mail (for example Resend)           | $0 up to 3,000 emails/month and 100/day; then $20/month                    |
| Stage 1   | Google sign-in, download repository | $0 expected, not rechecked                                                 |
| Stage 1   | Hosting of the sign-in page         | not chosen; Vercel Pro would be $20/month                                  |
| Stage 1   | Lawyer                              | not estimated                                                              |
| Stage 2   | EU server for the gateway           | from €5.49/month without VAT (Hetzner); real size after a load measurement |
| Stage 2   | Apple Developer                     | $99/year (not rechecked); also removes the macOS warning                   |
| Stage 2   | Google Play                         | $25 once (not rechecked)                                                   |
| Windows   | Code signing                        | €200–250/year for a person (checked 31.10.2026)                            |
| If closed | GitHub Actions on private source    | $12/month included; see below                                              |

Running cost: about **$25–45/month** in stages 1 and 3, about **$35–90/month** with
the gateway (estimate).

GitHub Actions, 18–25.11.2026: 379 runs, about 5,200 Linux and 126 macOS minutes by
job durations. On a private repository that is at most about $39/week at this pace
($0.006 and $0.062 per minute). Free while the source is public.

## Open decisions

1. Where the code of the account service lives. Recommended: a separate private
   repository from the first day, small enough for GitHub's free allowance.
2. The tunnel entrance (stage 2, above).
3. Whether the company board goes before Connect. Recommended: as listed, because
   the owner chose Connect as the second stage; the two do not depend on each other.

## Not verified

- Email-link sign-in finished in a desktop app with Supabase (device code or local
  callback): a prototype is the first task of stage 1.
- Relay of bb's core through a plugin WebSocket; any proxy with bb's WebSockets.
- Memory and traffic per connected client on the gateway.
- What Claude Desktop does with no network at all: not documented officially.
- Whether the MIT versions already published limit later plans: a question for the
  lawyer. bb's MIT notice stays in the product in any case.

## Order of work after approval

1. Owner: operator, lawyer, accounts (Supabase, mail, Google), DNS records.
2. Prototype of sign-in on a throwaway Supabase project, then the data model with
   security tests, the pages, the plugin, the download repository, the review.
3. First client. Stage 2 is planned in detail in its own document after that.
