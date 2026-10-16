// The alert webhook's signature, pinned where its rot is visible: the source.
//
// The delivery path predates this signature and works unsigned; the failure
// mode being guarded is therefore silence in the other direction — a
// re-stringify that signs different bytes than it sends, a secret that leaks
// through a read, a rotation that returns nothing (or a normal PATCH that
// returns the key). Each of those still typechecks, still builds, and still
// passes every test that does not know to look.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

const alerts = source("../../src/lib/alerts.ts");
const listRoute = source("../../src/app/api/alerts/route.ts");
const itemRoute = source("../../src/app/api/alerts/[id]/route.ts");
const fields = source("../../src/lib/fields.ts");

test("the body is stringified once and that exact string is signed, then sent", () => {
  const bodyAt = alerts.indexOf("const body = JSON.stringify(");
  const sigAt = alerts.indexOf('createHmac("sha256", rule.secret).update(body)');
  const fetchAt = alerts.indexOf("await fetch(rule.webhookUrl");
  assert.ok(bodyAt !== -1, "the bytes sent come from one stringify");
  assert.ok(sigAt !== -1, "the digest covers those bytes, not a re-serialization");
  assert.ok(bodyAt < sigAt && sigAt < fetchAt, "stringify, then sign, then send");
});

test("both spellings ride every delivery", () => {
  assert.match(alerts, /"X-Abetanalytics-Signature": signature,/);
  assert.match(alerts, /"X-Webhook-Signature": `sha256=\$\{signature\}`,/);
  assert.match(alerts, /"content-type": "application\/json",/);
  assert.match(alerts, /"User-Agent": "Abetanalytics-Webhook\/1\.0",/, "a receiver debugging a POST knows who sent it");
});

test("the firing is recorded before the delivery is attempted", () => {
  assert.ok(
    alerts.indexOf("alertEvent.create") !== -1 &&
      alerts.indexOf("alertEvent.create") < alerts.indexOf("await fetch(rule.webhookUrl"),
    "a webhook timeout must not lose the fact that the rule fired",
  );
});

test("the egress policy is still immediately above the fetch", () => {
  const check = alerts.indexOf('assertAllowedTarget(rule.webhookUrl, "webhookUrl")');
  const fetchAt = alerts.indexOf("await fetch(rule.webhookUrl");
  assert.ok(check !== -1 && fetchAt !== -1);
  assert.ok(check < fetchAt, "the check is what makes the destination safe; the order is not incidental");
  assert.ok(fetchAt - check < 200, "'immediately above' is the rule this pins");
});

test("creation mints the secret into the same write; reads preview it", () => {
  assert.match(listRoute, /const secret = crypto\.randomBytes\(32\)\.toString\("hex"\)/);
  assert.match(listRoute, /webhookUrl,\n\s+secret,/, "the secret is stored in the write that creates the rule");
  assert.match(listRoute, /rules\.map\(alertRulePreview\)/, "the list previews instead of echoing keys");
  assert.match(itemRoute, /alertRulePreview\(rule\)/, "the detail read previews too");
});

test("rotation is the one PATCH that returns the secret", () => {
  assert.match(fields, /rotateSecret: \{ kind: "bool" \}/);
  assert.match(itemRoute, /rotateSecret === true \? crypto\.randomBytes\(32\)\.toString\("hex"\) : undefined/);
  assert.match(itemRoute, /return NextResponse\.json\(newSecret \? rule : alertRulePreview\(rule\)\);/);
});
