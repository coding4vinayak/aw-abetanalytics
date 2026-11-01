# AbetAnalytics

![CI](https://github.com/coding4vinayak/aw-abetanalytics/actions/workflows/ci.yml/badge.svg)


Revenue intelligence your board will not argue with. Define a metric once,
snapshot it with its definition attached, argue never again.

## Quick start

```bash
npm install
cp .env.example .env        # DATABASE_URL points at the compose Postgres
docker compose up -d        # local Postgres 16
npx prisma migrate deploy   # applies the committed migrations
npm run db:seed             # demo workspace: 102 events, 3 metrics, dashboard
npm run dev                 # http://localhost:3600
```

`npm run test` runs the unit suite — metrics engine, alert comparisons,
delivery signing, export serialization — with no server and no database.

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

## First run (example data)

A new workspace is empty, and the dashboard used to say so with advice for
somebody who already writes code: *"No metrics yet. Create one via `POST
/api/metrics`"*. On a **card-up 14-day trial** that is a churn mechanism — the
buyer pays attention to an empty screen, never sees the product work, and the
card is charged for the privilege.

So the dashboard now offers one click:

```
POST   /api/example-data      # load a sample week (session or API key)
DELETE /api/example-data      # take it away again
```

It loads a real week — two metrics, 223 events, three frozen snapshots —
written through the same tables the API writes, so the number on the screen is
computed by the same engine that computes a customer's number. From there the
whole product works on it: the breakdown by channel, the read-only share link,
the weekly report, the "what changed?" panel.

Three rules keep it from being anything but example data:

- **It is labelled.** The metrics are named `Example: …` and the card says so
  on the dashboard, in a banner, while it is loaded.
- **It is removable in one click, and the removal is surgical** — the two
  `example_*` event types and the two example metrics, by id. A customer's own
  events are never touched, and their workspace is empty again afterwards.
- **It is idempotent.** A second call finds the example already there and
  changes nothing, so a double-click cannot double the events.

The door takes a **session or an API key**: the prospect who signs up on the
web and the prospect who integrates the API are the same buyer, and neither
should wait for the other to see the product work.

## Snapshots

`POST /api/snapshots { metricId, rangeStart, rangeEnd }` computes inline and
freezes the answer **with the definition as-run** (name, kind, config,
range). Renaming the metric or changing its config next week cannot rewrite
what the board agreed this week — proven by the smoke flow in this repo's
history (rename → snapshot still carries the old name). Pass `sync:false` to
enqueue large backfills on the `snapshots` queue instead.

A range that holds more than 50,000 events is refused with `422` rather than
answered from the first 50,000 rows: a number read from part of a window is not
the metric, and no field on a snapshot would say so. Preview and breakdown read
through the same bound.

### Sharing a frozen number

A snapshot exists to be seen, so the dashboard can hand one to someone who is
not signed in. The **Share** action on a metric's latest snapshot mints a
192-bit capability token and a read-only page at `/s/{token}` showing the value,
the range, and the **definition as-run** — and nothing else in the workspace.
The page is `noindex` (the link is the capability, not a public post) and is
served only through `findLiveSharedSnapshot`, whose `shareRevokedAt: null`
filter *is* the revocation: **Stop** kills a link, and sharing again mints a
fresh token that retires the old one. Minting is session-only from the
dashboard — the workspace comes from the session cookie, never a request body —
and a snapshot id from another tenant resolves to "not found". API callers use
`POST /api/snapshots/{id}/share` (idempotent; `201` the first time, `200` after)
and `DELETE /api/snapshots/{id}/share`, which share the same lib so the rules
cannot drift between the two doors.

### The weekly report

A number that has to be fetched is a number that gets forgotten. The
**Weekly report** panel schedules the same metric — over the same window,
frozen with its definition — to be **emailed** to you, with the same read-only
link the dashboard hands out, so the person who has to see the number can be
*sent* it.

```
POST   /api/reports                          # create a schedule
GET    /api/reports                          # list, with the next send time
DELETE /api/reports/{id}                     # cancel — deleting the row is the unsubscribe
POST   /api/reports/{id}/send                # send now, to check the address works
```

```
{ "metricId": "…", "email": "board@company.com",
  "dayOfWeek": 1, "hour": 8, "timezone": "Europe/Berlin", "windowDays": 7 }
```

Four things are worth knowing about it:

- **The emailed number is a real snapshot** — frozen with the definition as-run,
  and shared through the same revocable link. The emailed value and the value
  anyone opens later cannot drift apart.
- **A report never re-pages.** The alert rules are not evaluated for a
  report-generated snapshot: the customer may already have snapshotted that
  window and been paged about it, and a second page for the same number is how
  a monitoring tool gets muted.
- **The slot is a wall-clock time in a named zone.** "Every Monday at 08:00" in
  `Europe/Berlin` stays at 08:00 local across the daylight-saving change; the
  UTC instant moves, the promise does not. A schedule created *after* its slot
  waits for the next one.
- **The schedule owns the idempotency, not Redis.** `lastPeriod` is the
  occurrence already delivered, and it is compared on the row — so a restart, a
  second instance, or a retry cannot send the same week twice. A failed send is
  retried against the same window (three attempts), never a newer one.

The tick is an hourly BullMQ job registered on boot (`abetanalytics-reports`),
so a report does not need anyone to restart the app to arrive. **Send now**
does not consume the weekly slot: the real Monday still goes out.

## Export

The homepage says the numbers export for board packs, the terms say export
anytime, and the privacy page tells a departing customer to take a copy first.
Three session-authenticated doors make those sentences true:

| Door | What it returns |
| --- | --- |
| `GET /api/export` | Workspace JSON: team, invitations, metric definitions, frozen snapshots (definition + result), dashboards, alert rules and deliveries, webhook configuration. It names the raw-event count and points at the stream rather than pretending a truncated array is everything. |
| `GET /api/export/snapshots` | Board-pack CSV: one row per frozen snapshot, with the definition and result that produced it. A funnel is a snapshot with `kind=funnel`; its step counts and rates are in `result_json`, and `headline` is the overall conversion rate. |
| `GET /api/export/events` | Raw events as streamed CSV, paged by id in batches so the workspace never has to fit in memory. |

All three are owner/admin only: a member gets `403`, an anonymous caller `401`.
They leave credentials behind — password digests, session tokens, API keys and
their hashes, invitation token hashes, alert/webhook signing secrets and Stripe
ids. A snapshot's share token is a capability, so the JSON carries `shared:
true|false` and the share dates, never the URL. The board-pack writer prefixes
cells that begin with `=`, `+`, `-`, `@`, tab or CR with an apostrophe, so a
metric name cannot become a spreadsheet formula.

The JSON document is built in memory on purpose: it is the copy a buyer reads,
and ids are preserved so rows can be rejoined. Raw events are deliberately not
embedded; they have their own streamed door.

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

Every management route is workspace-scoped and requires an API key, except the
session-only export and billing doors noted below. A browser session is the other half — see [Accounts](#accounts-browser). `workspaceId`
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

All routes below need the key from [Authentication](#authentication) unless the
comment says `session`; those take the signed-in browser session instead. The
snippets omit the header for width.

**The machine-readable contract**: `GET /openapi.json` (the conventional path
every tool probes first) and `GET /api/openapi` (the versioned alias) serve the
same OpenAPI 3.1 document, unauthenticated — a contract is a description, and an
integrator should be able to read it before it has a key. It cannot drift from
the product: `npm run check:contract` reads every claim back out of the source
that serves it — every documented call has a route that answers it and every
route that answers is documented, every request body is compared with the
app's own declared field table, the auth a route enforces is the auth the
contract advertises, and the version is the app's own version.

**The deep-content file**: `GET /llms-full.txt` carries the shipped index
(`llms.txt`) verbatim and then every operation the contract answers, each with
its own summary and the door it declares — built from those two sources, not
from hand-written prose, so it cannot say more than the product does.
`npm run check:llms-full` (in CI) fails naming the first line that moved
against a stale index or contract; rebuild with `npm run build:llms-full`.

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
POST   /api/snapshots/{id}/share              # mint (or return) a read-only link; 201 the first time
DELETE /api/snapshots/{id}/share              # revoke it — the URL 404s from then on
GET    /api/reports                          # weekly reports, with the next send time
POST   /api/reports                          # schedule one (metric, address, day, hour, timezone)
DELETE /api/reports/{id}                     # cancel — deleting the row is the unsubscribe
POST   /api/reports/{id}/send                # send now, to check the address works
POST   /api/metrics/{id}/breakdown         # split movement across a dimension's segments, current vs previous range
GET    /api/dashboards?workspaceId=        # list
POST   /api/dashboards                     # create (metricIds must be in-workspace)
GET    /api/alerts?workspaceId=&metricId=  # rules (signing secret previewed)
POST   /api/alerts                         # rule (operator, http(s) webhook; secret returned once)
GET    /api/alerts/{id}?events=true        # what fired, with delivery receipts
GET    /api/webhooks?workspaceId=          # subscriptions (signing secret previewed)
POST   /api/webhooks                       # subscription (url + events; secret returned once)
GET    /api/webhooks/{id}                  # one subscription
PATCH  /api/webhooks/{id}                  # edit url/events/isActive
DELETE /api/webhooks/{id}
GET    /api/export                         # workspace JSON (session; owner/admin)
GET    /api/export/snapshots               # board-pack CSV (session; owner/admin)
GET    /api/export/events                  # raw events CSV, streamed (session; owner/admin)
POST   /api/ai/explain-metric              # explain a snapshot-to-snapshot move
```

## Breakdown (read-only)

`POST /api/metrics/{id}/breakdown` takes `{ metricId, currentStart, currentEnd, previousStart, previousEnd, dimension? }`
and splits a metric's movement between two adjacent ranges across the values of one dimension (`dimension` omitted = the
engine picks the highest-coverage one). The kind and config are taken from the latest snapshot's frozen definition, so the
breakdown explains exactly the number the board showed, and every segment's value is computed by `computeMetric` itself —
there is no second counting rule that could drift out of agreement with the headline. Only events the metric actually
reads (its event type and filters) can own a segment; events it reads that do not carry the chosen dimension share
`(not set)`, so for an additive metric the segments add back to the headline. Segments are ranked by movement,
capped at 20. The dashboard surfaces it per metric ("Breakdown") through a session-authenticated server action: the browser
half never needs an API key, and the workspace comes from the session, not the payload.

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

Every delivery is signed with HMAC-SHA256 over the exact body bytes, under
two headers carrying the same hex: `X-Abetanalytics-Signature` and
`X-Webhook-Signature: sha256=<hex>`. The second is the generic spelling an
inbound nuCRM plugin webhook verifies natively — point a rule's `webhookUrl`
straight at one and nuCRM accepts the call with no adapter in between. The
secret is minted with the rule and returned by the response that creates it;
reads show a preview, and `PATCH /api/alerts/{id}` with
`{ "rotateSecret": true }` mints a new one and is the only response that
hands it back. Verify against the raw request bytes — re-serialising the JSON
before verification fails on the first key whose ordering differs, and that
reads like a broken signature rather than a changed string.

Alert deliveries carry the same two headers, and the alert&rsquo;s own `AlertEvent` id now
rides in the body as `id` — one id for the firing, the receipt and the dedupe key,
inside the signed bytes.

## Webhooks

Workspace-level subscriptions (`/api/webhooks`): each row is a URL plus the
event names it wants. Two events exist and the set is closed at subscribe
time — a name nothing emits is a 400, not a stored row, because a subscription
filtered on a typo is the same silence as no subscription at all:

```
snapshot.created   a metric was frozen with its definition as-run
alert.triggered    a rule's threshold was met at snapshot time (recorded first)
```

Delivery is inline and best-effort, in the same shape as alert deliveries:
one `id` (`evt_…`) and timestamp per logical event shared by every receiver,
body `{ id, event, timestamp, data }`, signed HMAC-SHA256 over the exact body
bytes under the same two headers — `X-Abetanalytics-Signature` and
`X-Webhook-Signature: sha256=<hex>`, so a subscription can point straight at
an inbound nuCRM plugin webhook. The secret is returned once by POST; reads
preview it. A receiver that is down is logged, not retried, and never fails
the snapshot that emitted the event. The menu, the emitters and the headers
are pinned by `tests/unit/webhook-dispatch.test.ts` against the source itself.

Every delivery also carries `X-Webhook-Timestamp` (send-time milliseconds) and
`X-Webhook-Delivery` (the same `id`). nuCRM's plugin receiver enforces a 5-minute
freshness window when the timestamp header is present and skips the check when it
is absent, so a stale re-send is refused rather than accepted twice. The timestamp
sits outside the signed bytes, so what a receiver can truly rely on is the delivery
id: it is inside the body the digest covers, which means a receiver that remembers
ids rejects the duplicate arrival and a replayer cannot hand it a new one without
breaking the signature.

## Billing

$19/month or $190/year (two months free) via Stripe. Three endpoints under `/api/billing`, all session-authenticated — the workspace comes from the signed-in session, never from the request:

POST /api/billing/checkout
POST /api/billing/portal
POST /api/billing/webhook

`checkout` takes `{ priceId: "FLAT_MONTHLY" | "FLAT_ANNUAL", returnUrl }` and returns `{ url }` for the Stripe-hosted page. A workspace the `Subscription` row says is already trialing, active, past due or unpaid gets a 409 instead of a second checkout: another session would be another subscription, and nothing cancels the one Stripe is already charging, so a plan switch or a fixed card is the portal's job. The `/pricing` page reads the same row before it sells anything: a workspace that is already billed sees its plan named, with the renewal date the row carries, its own card marked *Your plan* and the other turned into a portal link — a trial button that answers 409 reads as a broken button, and a buyer with nothing to decide has nowhere to be told where to change it. The webhook verifies the Stripe signature and syncs `checkout.session.completed`, `customer.subscription.*`, and `invoice.payment_failed` into the `Subscription` row. Replays are answered `duplicate` without re-running the handler: every verified delivery is claimed by its event id before it is handled, and the row carries the newest event time it has applied, so a redelivered or late-arriving snapshot cannot re-fire a mail or drag the status backwards. Setup: create the two prices in Stripe, set `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_FLAT_MONTHLY`, `STRIPE_PRICE_FLAT_ANNUAL`, forward webhooks with `stripe listen --forward-to localhost:3600/api/billing/webhook`. Signature checks are unit-tested offline in `tests/unit/billing.test.ts` — with the refusal ordering, the nudge and cancellation jobs and the pricing-page states pinned the same way in their own files.

Every paid plan opens with a 14-day card-up trial (`trial_period_days` on the subscription), so the first invoice is dated two weeks out and the dashboard banner counts the days down to it. Two warnings are armed off the webhook that confirms the trial — delayed BullMQ jobs on `abetanalytics-billing`, at three days left and one day left — and each one re-reads the `Subscription` row before it mails: a workspace that already converted, cancelled, or had its trial moved gets silence rather than a wrong date. Arming is best-effort in the same shape as every other mail here, so with Redis down the webhook still answers 200 and no nudge is sent; `REDIS_URL` has to point somewhere real for these to arrive. The job id names the trial period, so a Stripe webhook retry cannot double-send. A cancellation is answered the same way: `customer.subscription.deleted` arms a confirmation (no further charge, nothing deleted) and one win-back mail seven days later, both on the same `-billing` queue. Those two are keyed on the Stripe subscription id rather than the workspace, because a subscription is deleted exactly once — a re-delivered event cannot double-send, while a buyer who comes back and leaves again is a new subscription and gets a new pair. Each mails only if the row still says `canceled` *for that subscription id*: a workspace that returned is not a churn risk, and telling a paying customer they are gone is worse than saying nothing. Every billing mail that has to go looking for a person — dunning, conversion, nudge, cancellation, win-back — is addressed by the same `ownerOf` query: the oldest `OWNER` membership, which is the account that ran checkout. Not the Stripe customer, which `ensureCustomer` creates with an empty email. The receipt is the exception, and a good one: its address is the one the buyer typed into the checkout page, so it needs no lookup. The conversion mail is the one that fails quietly, inside a `try`/`catch` that logs: by the time it would be sent the sync has already overwritten the status that made the transition visible, so the retry a non-200 buys has nothing left to announce — a loud failure there deletes the mail rather than delaying it. A declined-payment notice keeps the opposite shape, because nothing is consumed by sending it: if the lookup fails the webhook fails, and Stripe's retry delivers the mail.

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
read from `src/app/api/health/route.ts`) and the snapshot's durable record is the database, while a
failed job is kept, capped, as the only surviving record of its payload (the leadgenius
convention #61, ported #64). The queue keeps its bare name:
`bull:snapshots:*` already holds jobs, and renaming would orphan them.
Postgres is the runtime provider since `chore/postgres-switch` (provider switch,
fresh migration history, regenerate — the abetConnect recipe). Events cap at 50,000 rows per compute
and per snapshot read. A range that holds more is refused with `422` (preview,
snapshot and breakdown alike) rather than answered from a truncated window;
past that, narrow the range or shard by workspace.
