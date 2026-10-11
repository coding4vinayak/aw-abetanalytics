# AbetAnalytics

![CI](https://github.com/coding4vinayak/aw-abetanalytics/actions/workflows/ci.yml/badge.svg)


Revenue intelligence your board will not argue with. Define a metric once,
snapshot it with its definition attached, argue never again.

## Quick start

```bash
npm install
npx prisma migrate dev      # creates the SQLite database
npm run db:seed             # demo workspace: 102 events, 3 metrics, dashboard
npm run dev                 # http://localhost:3600
```

`npm run test` runs 12 unit tests over the metrics engine and alert
comparisons with no server and no database.

## Metrics

| Kind | Config | Answers |
| --- | --- | --- |
| `count` | `event`, `filters?` | How many |
| `sum` / `avg` | `event`, `field?` (default `value`), `filters?` | How much / on average |
| `unique` | `event`, `field?`, `filters?` | How many distinct |
| `funnel` | `steps[{event, filters?}]`, `identityField` | Step counts + conversion, ordered by timestamp |

Filters are dimension equalities (`plan: "pro"`) or any-of lists
(`plan: ["pro", "team"]`). Fields use dot paths into `{value, ...dimensions}`.
Definitions are validated at creation: a broken metric fails with 422 today,
not at the first snapshot a month later when nobody remembers writing it.

## Snapshots

`POST /api/snapshots { metricId, rangeStart, rangeEnd }` computes inline and
freezes the answer **with the definition as-run** (name, kind, config,
range). Renaming the metric or changing its config next week cannot rewrite
what the board agreed this week — proven by the smoke flow in this repo's
history (rename → snapshot still carries the old name). Pass `sync:false` to
enqueue large backfills on the `snapshots` queue instead.

## Accounts (browser)

Machine callers authenticate with an API key above. Humans sign in:

```
GET  /login                # sign in
POST /signup               # create a workspace and an account
GET  /dashboard            # your own workspace (needs the session cookie)
GET  /members              # seats, invites, roles (owner/admin)
GET  /invite/{token}       # accept a one-time invitation link
```

A signup mints a `User` and a `Workspace` in one transaction and drops the
browser straight into it. Passwords are scrypt with the work factor recorded
beside the digest, so the cost can be raised later without invalidating anyone.
The session cookie holds a random 32-byte token and the database keeps only its
sha256; it is httpOnly, sameSite=lax, and `secure` outside development.

`?workspace=demo` stays public on purpose — it is what the landing pages link to
and what a prospect evaluates. Every other workspace requires the session that
owns it: naming someone else's slug is refused rather than served, and an
anonymous visitor is pointed at the login form instead of the data.

Sign-in is rate-limited per address (10 failures, 15-minute lock) and signup to
5 workspaces, so one client cannot grind through a list of accounts. Failed
logins take the same time whether or not the address exists.

A brand-new account has no API key, so the dashboard offers to mint one and
shows it exactly once — only a hash is stored. The prompt is scoped to
signed-in workspaces: a stranger on the public demo is never nagged to sign up.
It is a server action rather than a `POST /api/keys` call so the plaintext goes
straight into the page and never into a URL, a referrer, or an access log.

### Password reset and email verification

```
GET  /forgot-password             # request a reset link
GET  /reset-password?token=       # choose a new password
GET  /verify-email?token=         # confirm the address
```

Both links are **POST-only**: the page reads the token, the button redeems it. A
GET that changes state is triggered by link previewers, chat clients and
corporate scanners, so a single Slack unfurl would spend the token before the
person read it.

Tokens are stored hashed (sha256), single-use, and expired — reset in 1 hour,
verification in 24. Issuing a new one deletes the previous, so a link forwarded
last year stops working the moment a fresh one is requested. Reset requests are
rate limited to 3 per address per hour.

Redeeming a reset also **destroys every session on that account**. A password
change that leaves old cookies working evicts nobody, which defeats the entire
point of resetting. The same gap existed in abetConnect and is fixed there too.

The request endpoint answers identically whether or not the address has an
account — a "no such user" there is a customer enumeration oracle.

### Email delivery is honest about itself

`send()` returns which transport actually ran, and the UI says so:

| State | Behaviour |
|---|---|
| `RESEND_API_KEY` or `EMAIL_WEBHOOK_URL` set | Message is delivered; verification is enforced at sign-in |
| Neither set | Link is written to the server log, and the page says plainly that nothing was sent |

An account created with no provider configured starts **pre-verified**, because
enforcing a click on a message that can never arrive would lock the account out
of its own product. With a provider set, sign-up starts unverified, sends the
link, and `signIn` refuses until it is confirmed. A provider outage at
verification is swallowed deliberately — the account exists, and the link can be
re-sent from the dashboard — because failing signup after the row is written
would leave an account nobody can reach.

No new dependency: the HTTP sender is `fetch` only, and `setEmailSender()`
accepts SMTP, SES or anything else without touching a route.

### Teams

Anyone with an account belongs to one or more workspaces, each with a role:
`OWNER` (created at signup, never issuable by invite), `ADMIN`, or `MEMBER`.
Owners and admins invite by email from `/members`; the link is single-use,
expires in 7 days, names one address, and is shown once because only its hash
is stored. Re-inviting rotates the old link dead. Accepting moves the browser
into the new workspace. Removing a seat destroys that person's sessions in it
immediately — revoking access and leaving the cookie working would be the same
mistake twice. The dashboard bar lists every workspace the account can open.

An admin can invite members but cannot mint another admin; only an owner can.
A member cannot invite, see keys, or change seats. Ownership never transfers
through the invite path — that is a decision, not a missing feature.

Set `SESSION_COOKIE` if several of these products ever share one hostname, so
their cookies stay apart. It defaults to `abetworks_session`, which is safe as
long as each product has its own database — a token from one is simply not found
in another's session table.

This file's provenance: the auth surface shipped as one source, byte-copied across six
apps during the Abetworks campaign. The vendoring scripts and drift gate that enforced
identity are retired. This app's copy is its own and can evolve independently.
Full context: `abetworks-history` §8.20 and §8.44.

## Authentication

Every management route is workspace-scoped and requires an API key. A browser session is the other half — see [Accounts](#accounts-browser). `workspaceId`
in the query or body is **checked against the key** — a mismatch is a `403`,
not a silent cross-tenant read.

```bash
# Mint a key for the demo workspace (side-effect free, mints a fresh key)
npm run seed:key            # prints the plaintext once

# Call anything
curl http://127.0.0.1:3600/api/metrics?workspaceId=cmuc523ed0000ni8ngygco4hc \
  -H "Authorization: Bearer <paste-key>"
```

Keys are prefixed `an_live_` so a leaked one is self-identifying. Only a sha256
hash is stored; the plaintext is shown once and cannot be recovered.

| Response | Meaning |
|---|---|
| `401` | No key, unknown key, or a revoked key |
| `403` | Valid key, but that `workspaceId` is not its workspace |

Deliberately **not** key-gated: `GET /api/health`, the provider inbound
webhook receivers (Twilio/WhatsApp/LinkedIn — they authenticate by their own
protocol), and `POST /api/billing/webhook` (Stripe signature).

## API

All routes below need the key from [Authentication](#authentication) —
the snippets omit the header for width.

```
GET    /api/health                         # liveness + DB ping, no key
GET    /api/events?workspaceId=&type=      # list, newest first
POST   /api/events                         # single or { events: [] } batch (max 1000)
GET    /api/metrics?workspaceId=&page=&limit=   # list, newest first (limit caps at 100)
POST   /api/metrics                        # create (validated eagerly)
GET    /api/metrics/{id}?preview=1&start=&end=  # detail, or compute without persisting
PATCH  /api/metrics/{id}                   # edit (validated; history untouched)
DELETE /api/metrics/{id}
POST   /api/snapshots                      # compute + freeze (+ evaluate alerts)
GET    /api/snapshots?metricId=&workspaceId=
GET    /api/dashboards?workspaceId=        # list
POST   /api/dashboards                     # create (metricIds must be in-workspace)
GET    /api/alerts?workspaceId=&metricId=  # rules
POST   /api/alerts                         # rule (operator gt/gte/lt/lte, http(s) webhook)
GET    /api/alerts/{id}?events=true        # what fired, with delivery receipts
POST   /api/ai/explain-metric              # explain a snapshot-to-snapshot move
```

## AI (optional)

`POST /api/ai/explain-metric` takes `{ metricId, dimension?, model? }` and
explains the gap between the two most recent snapshots: what moved, the ranked
contributors, checkable alternative hypotheses, and a recommendation. It reads
the **frozen** definition on each snapshot and computes the per-segment
breakdown with the metrics engine itself, so the explanation cannot disagree
with the headline. A model may only cite segments present in the breakdown —
invented segments are dropped (`onlyKnownSegments`, unit-tested). Read-only.
Without `LLM_API_KEY` the headline comparison is still returned with
`configured: false`.

Same key setup as the other apps. Offline contract unit-tested in
`tests/unit/ai-explain.test.ts`.

## Alerts

Rules evaluate at snapshot time, never on live queries, so an alert always
points at a frozen number. A null headline (no data) stays quiet rather than
firing on nothing. Firing records an `AlertEvent` first, then delivers —
a webhook timeout loses nothing. `delivered:false` with the HTTP status (or
network error) is the receipt.

## Putting it somewhere

```bash
npm ci
npm run db:deploy
npm run build
npm start
```

Point the load balancer at `GET /api/health` (200 = serving, 503 = DB down).
Queue workers (`src/lib/queue.ts`, BullMQ + Redis) drain the `snapshots` queue. The
Queue is built on first touch rather than at import: constructing one connects to Redis
even on a `lazyConnect` client, so an import alone wrote `bull:snapshots:meta` — measured
on the pre-fix module against a scratch db, rc=124 (never exited) with that key left
behind, and dev `REDIS_URL` defaults to db 0, so it was live state being written by a
test that only wanted to read a name. `src/lib/shutdown.ts` drains it on SIGTERM/SIGINT,
installed from `instrumentation.ts` in production only, because Next 16.2.12 exposes no
shutdown hook at all (`InstrumentationModule` is `register` and `onRequestError`, read
from its own `.d.ts`); the drain waits for the workers' in-flight Redis setup before
closing anything, and disconnects rather than quitting. Every job bounds its retention at
construction (`defaultJobOptions: { removeOnComplete: true, removeOnFail: 100 }`) — a
completed snapshot has no reader (`GET /api/health` counts only `waiting`/`active`/`failed`,
read from `src/app/api/health/route.ts`) and the snapshot's durable record is SQLite, while a
failed job is kept, capped, as the only surviving record of its payload (the leadgenius
convention #61, ported #64). The queue keeps its bare name:
`bull:snapshots:*` already holds jobs, and renaming would orphan them.
For Postgres, follow the same three steps as abetConnect: provider switch,
fresh migration history, regenerate. Events cap at 50k rows per compute and
50k per snapshot read; past that, narrow the range or shard by workspace.
