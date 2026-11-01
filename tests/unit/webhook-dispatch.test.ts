// Outbound webhooks, pinned where their rot is visible: the source.
//
// The failure mode being guarded is silence, not a crash. A declared event
// with no emitter, an emitter that slipped ahead of the row that made the
// state true, a delivery that lost its egress check or one of its two
// signatures, a subscription write that dropped the unknown-name refusal —
// each still typechecks, still builds, and still passes every runtime test
// that does not know to look. A source-reading test is the one that looks:
// the menu comes from `lib/webhooks.ts` itself, the emissions from
// `snapshots.ts` and `alerts.ts`, and the assertions below are the contract
// the README documents, so drift between the two is a failing test rather
// than a support ticket.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

const sender = source("../../src/lib/webhooks.ts");
const snapshots = source("../../src/lib/snapshots.ts");
const alerts = source("../../src/lib/alerts.ts");
const listRoute = source("../../src/app/api/webhooks/route.ts");
const idRoute = source("../../src/app/api/webhooks/[id]/route.ts");

const declared = sender.match(/WEBHOOK_EVENTS = \[([^\]]+)\]/)?.[1] ?? "";
const menu = [...declared.matchAll(/"([^"]+)"/g)].map((m) => m[1]);

test("the menu is exactly the two events the docs name, in the order the docs list them", () => {
  assert.deepEqual(menu, ["snapshot.created", "alert.triggered"]);
});

test("every declared event has an emitter, one announce per event", () => {
  for (const event of menu) {
    assert.ok(
      snapshots.includes(`"${event}"`) || alerts.includes(`"${event}"`),
      `no emitter for ${event} in snapshots.ts or alerts.ts`,
    );
  }
  assert.equal((snapshots.match(/triggerWebhooks\(/g) ?? []).length, 1, "one announce in snapshots.ts");
  assert.equal((alerts.match(/triggerWebhooks\(/g) ?? []).length, 1, "one announce in alerts.ts");
});

test("every announce sits after the write that makes the state true", () => {
  const snap = snapshots.indexOf('"snapshot.created"');
  const snapWrite = snapshots.lastIndexOf("prisma.snapshot.create(", snap);
  assert.ok(snapWrite !== -1 && snapWrite < snap, "the snapshot row is committed before the event about it");

  const alert = alerts.indexOf('"alert.triggered"');
  const alertWrite = alerts.lastIndexOf("prisma.alertEvent.create(", alert);
  assert.ok(alertWrite !== -1 && alertWrite < alert, "the firing is recorded before the event about it");
});

test("the dispatcher signs the body once, under both spellings", () => {
  assert.match(sender, /createHmac\("sha256", secret\)\.update\(body\)\.digest\("hex"\)/);
  assert.match(sender, /"X-Abetanalytics-Signature": signature,/);
  assert.match(sender, /"X-Webhook-Signature": `sha256=\$\{signature\}`,/);
  assert.match(sender, /"X-Webhook-Timestamp": String\(Date\.now\(\)\)/,
    "freshness: nuCRM's plugin receiver enforces the 5-minute window only when this header is present");
  assert.match(sender, /"X-Webhook-Delivery": payload\.id/,
    "the id inside the signed body — the value a receiver can dedupe on and a replayer cannot refresh");
  assert.match(sender, /id: `evt_\$\{crypto\.randomBytes/, "the payload id is evt_-prefixed so a receiver can deduplicate");
});

test("every delivery passes the egress check immediately above its fetch", () => {
  const check = sender.indexOf('await assertAllowedTarget(rawUrl, "url")');
  const fetchAt = sender.indexOf("await fetch(rawUrl");
  assert.ok(check !== -1 && fetchAt !== -1);
  assert.ok(check < fetchAt && fetchAt - check < 200);
  assert.ok(sender.includes("AbortSignal.timeout(5000)"));
  assert.match(sender, /await Promise\.allSettled\(matching\.map/);
  assert.match(sender, /catch \(error\) \{\s*console\.error\(/);
});

test("subscription writes refuse an unknown event and an internal destination", () => {
  assert.match(listRoute, /unknownEventsProblem\(events\.values\)/);
  assert.match(idRoute, /unknownEventsProblem\(events\.values\)/);
  assert.match(listRoute, /classifyTarget\(url, "url"\)/);
  assert.match(idRoute, /classifyTarget\(checked\.data\.url, "url"\)/);
});

test("read responses preview the secret; only the create response carries it", () => {
  assert.match(sender, /export function webhookPreview/);
  assert.match(listRoute, /webhooks\.map\(webhookPreview\)/);
  assert.match(idRoute, /webhookPreview\(webhook\)/);
  assert.match(listRoute, /NextResponse\.json\(webhook, \{ status: 201 \}\)/, "create answers the raw row, secret included");
});

test("the subscription routes authenticate as the house pattern", () => {
  assert.match(listRoute, /await authedWorkspaceId\(request, body\.workspaceId\)/, "POST authenticates the body's workspace");
  assert.match(idRoute, /await assertOwns\(request, owned\.workspaceId\)/);
});
