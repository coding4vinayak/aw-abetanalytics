// The engine's own rules, one test per kind, each named after the request that
// motivated it. Those requests are in `n5-an-before.txt` and the table at the top
// of `src/lib/validate.ts`; this file is what keeps them from coming back when a
// table is edited and nobody re-runs a probe.
import { test } from "node:test";
import assert from "node:assert/strict";
import { asDate, boolFlag, NO_FIELD_TO_UPDATE, readJson, validateArray, validateBody, type Schema } from "../../src/lib/validate";
import { ALERT_OPERATORS, METRIC_KINDS, METRIC_STATUSES } from "../../src/lib/enums";


const TEXT: Schema = { name: { kind: "text", required: true, max: 200 } };
const ENUM: Schema = { status: { kind: "enum", values: METRIC_STATUSES } };
const NUMBER: Schema = { threshold: { kind: "number", required: true } };
const BOOL: Schema = { isActive: { kind: "bool" } };
const DATE: Schema = { occurredAt: { kind: "date" } };
const JSON_: Schema = { config: { kind: "json" } };

async function errorOf(result: { error?: { json: () => Promise<unknown> } }) {
  assert.ok(result.error, "expected a response, not a validation");
  return (await result.error!.json()) as { error: string; fields: Record<string, string> };
}

test("a body that is not an object is named as the body, not as a field", async () => {
  // `validateBody` sees an already-parsed value, so unparseable text is not one
  // of its cases — that is `readJson`'s, below.
  for (const [value, words] of [["prose", "a string"], [42, "a number"], [[], "an array"], [null, "null"]] as const) {
    const result = validateBody(value, TEXT);
    const body = await errorOf(result);
    assert.equal(body.fields.body !== undefined, true, `${JSON.stringify(value)}: ${body.error}`);
    assert.match(body.error, /must be a JSON object/);
    assert.match(body.error, new RegExp(words), `a ${words} body should be described as one`);
  }
});

test("text is trimmed, because a name of spaces is a row nobody can find", async () => {
  const trimmed = validateBody({ name: "  Weekly signups  " }, TEXT);
  assert.equal(trimmed.ok, true);
  assert.equal(trimmed.data?.name, "Weekly signups");

  const blank = await errorOf(validateBody({ name: "   " }, TEXT));
  assert.match(blank.error, /non-empty/);

  const absent = await errorOf(validateBody({}, TEXT));
  assert.match(absent.error, /name is required/);
});

test("the wrong type is answered as the wrong type, not as a missing field", async () => {
  const body = await errorOf(validateBody({ name: 42 }, TEXT));
  assert.match(body.error, /must be text, got a number/);
  assert.equal(body.fields.name, "name must be text, got a number");

  // The message this round replaced: `if (!name || !kind)` said "name, kind
  // required" to a caller who had sent both.
  assert.doesNotMatch(body.error, /required/);
});

test("describe() agrees with the noun, because it is the client's whole answer", async () => {
  // Only values that reach a kind's type check get the `got …` wording; null is
  // answered by the null branch in its own words ("… cannot be null"), which the
  // test below pins. describe(null) itself shows up as a body and as an array
  // entry, both asserted there.
  for (const [value, words] of [[{}, "an object"], [[1], "an array"], [42, "a number"], [true, "a boolean"]] as const) {
    const body = await errorOf(validateBody({ name: value }, TEXT));
    assert.match(body.error, new RegExp(`got ${words}$`));
  }
});

test("a long name is refused by length, and the answer quotes both numbers", async () => {
  const body = await errorOf(validateBody({ name: "x".repeat(5001) }, { name: { kind: "text", max: 50 } }));
  assert.match(body.error, /is 5001 characters; at most 50/);
});

test("an enum is the list the schema only describes, matched exactly", async () => {
  assert.equal(validateBody({ status: "ACTIVE" }, ENUM).ok, true);
  for (const value of ["archived", "BOGUS", "", "ACTIVE "]) {
    const body = await errorOf(validateBody({ status: value }, ENUM));
    assert.match(body.error, /ACTIVE \| ARCHIVED/);
  }
  // Case is the whole bug: `status: "archived"` stored and then matched nothing.
  assert.equal(validateBody({ status: "archived" }, ENUM).ok, false);
  const wrongType = await errorOf(validateBody({ status: 42 }, ENUM));
  assert.match(wrongType.error, /got a number/);
  assert.equal(METRIC_KINDS.length, 5);
  assert.equal(ALERT_OPERATORS.length, 4);
});

test("a number is a number, and a numeric string is told to unquote it", async () => {
  assert.equal(validateBody({ threshold: 10 }, NUMBER).ok, true);
  assert.equal(validateBody({ threshold: 0 }, NUMBER).ok, true);
  assert.equal(validateBody({ threshold: -1.5 }, NUMBER).ok, true, "threshold is a Float, not an int");

  const text = await errorOf(validateBody({ threshold: "10" }, NUMBER));
  assert.match(text.error, /"10" as text — send it unquoted/);

  for (const value of [NaN, Infinity, BigInt(42), [1], {}, "prose"]) {
    assert.equal(validateBody({ threshold: value as unknown }, NUMBER).ok, false, `${String(value)} is not a finite number`);
  }

  // The measured one: `value: "5"` was a 201 with the value dropped.
  const dropped = validateBody({ value: "5" }, { value: { kind: "number" } });
  assert.equal(dropped.ok, false);
});

test("a boolean column takes a boolean, and only a boolean", async () => {
  assert.equal(validateBody({ isActive: true }, BOOL).ok, true);
  assert.equal(validateBody({ isActive: false }, BOOL).ok, true, "false must survive — it is the value that was being lost");
  assert.equal(validateBody({}, BOOL).ok, true, "absent means not mentioned");

  for (const value of ["no", "false", "true", 1, 0, [], {}, ""]) {
    const result = validateBody({ isActive: value as unknown }, BOOL);
    assert.equal(result.ok, false, `Boolean(${JSON.stringify(value)}) is true; a check must not be`);
  }
  const words = await errorOf(validateBody({ isActive: "no" }, BOOL));
  assert.match(words.error, /must be true or false, got a string — send it unquoted/);
});

test("a date is ISO text, and a number is not a date anyone meant", async () => {
  const ok = validateBody({ occurredAt: "2026-10-03T12:00:00.000Z" }, DATE);
  assert.equal(ok.ok, true);
  assert.ok(ok.data?.occurredAt instanceof Date);

  // The measured one: `new Date(String(42))` reads "42" as a year and stored
  // 2042-01-01 — an event in the future, in no window anyone queries.
  assert.equal(validateBody({ occurredAt: 42 }, DATE).ok, false);
  const garbage = await errorOf(validateBody({ occurredAt: "garbage" }, DATE));
  assert.match(garbage.error, /is not a date: "garbage"/);
});

test("asDate narrows what the date kind returns, without re-judging it", () => {
  const iso = "2026-01-01T00:00:00.000Z";
  assert.equal(asDate(iso).toISOString(), iso);
  const d = new Date(iso);
  // A Date in is returned as the same instant, not copied. Nothing in this app
  // mutates a Date after validating it, and the route that needed the narrowing
  // (`snapshots`) passes the value straight to Prisma — so the guarantee worth
  // pinning here is the instant, not the identity.
  assert.equal(asDate(d).getTime(), d.getTime());
  assert.ok(asDate(d) instanceof Date);
});

test("json is an object or an array, sized in bytes, and never null", async () => {
  assert.equal(validateBody({ config: { event: "page_view" } }, JSON_).ok, true);
  assert.equal(validateBody({ config: [] }, JSON_).ok, true, "the array check belongs to the route that reads it");
  assert.equal(validateBody({ config: 42 }, JSON_).ok, false, "asRecord(42) is {}, which is how a wrong type became 'count needs an event'");

  const nulld = await errorOf(validateBody({ config: null }, JSON_));
  assert.match(nulld.error, /send \{\} to clear it/);

  // `objectOnly` is the flag for a Json column whose readers spread it as an
  // object: `Event.dimensions` with `[]` measured as a 201 on this round's first
  // after-run, stored as `[]`, which `asRecord` then answered with `{}` at every
  // read — a value that survives the write and vanishes on the way out.
  const OBJECT_ONLY: Schema = { dimensions: { kind: "json", objectOnly: true } };
  assert.equal(validateBody({ dimensions: { plan: "pro" } }, OBJECT_ONLY).ok, true);
  for (const value of [[], [1, 2]]) {
    const array = await errorOf(validateBody({ dimensions: value }, OBJECT_ONLY));
    assert.match(array.error, /dimensions must be an object, got an array/);
  }
});

test("null clears a nullable column and is refused on one that is NOT NULL", async () => {
  assert.equal(validateBody({ description: null }, { description: { kind: "text", nullable: true } }).ok, true);
  const onto = await errorOf(validateBody({ status: null }, ENUM));
  assert.match(onto.error, /cannot be null; omit it to leave the value alone/);
  const required = await errorOf(validateBody({ threshold: null }, NUMBER));
  assert.match(required.error, /required and cannot be null/);
});

test("a PATCH that names nothing is refused, in the engine's own words", async () => {
  const result = validateBody({}, { name: { kind: "text" } }, { requireWrite: true });
  assert.equal(result.ok, false);
  const body = await errorOf(result);
  assert.equal(body.error, NO_FIELD_TO_UPDATE);
  // Without the flag, the same body is a legal "change nothing" request.
  assert.equal(validateBody({}, { name: { kind: "text" } }).ok, true);
});

test("every field's problem is reported at once", async () => {
  const result = validateBody({ name: 42, status: 42, threshold: "x" }, {
    name: { kind: "text", required: true },
    status: { kind: "enum", values: METRIC_STATUSES },
    threshold: { kind: "number" },
  });
  const body = await errorOf(result);
  assert.equal(Object.keys(body.fields).length, 3);
  assert.equal(body.error.split("; ").length, 3);
});

test("a field the route did not declare is not passed through", () => {
  const result = validateBody({ name: "ok", isActive: "no", threshold: "10", workspaceId: "other" }, TEXT);
  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(result.data ?? {}), ["name"], "the route spreads what the table declares, nothing else");
});

test("validateArray names the entry, so a backfill is not found by hand", async () => {
  const ITEM: Schema = { type: { kind: "text", required: true }, value: { kind: "number" } };
  const good = validateArray([{ type: "a", value: 1 }, { type: "b" }], ITEM, "events");
  assert.equal(good.ok, true);
  assert.equal(good.data?.length, 2);

  const bad = await errorOf(validateArray([{ type: "a" }, { type: 42 }], ITEM, "events"));
  assert.equal(Object.keys(bad.fields).length, 1);
  assert.match(bad.fields["events[1].type"], /must be text, got a number/);

  const notArray = await errorOf(validateArray("prose", ITEM, "events"));
  assert.match(notArray.error, /events must be an array, got a string/);

  // The cap: 1002 events measured as `{"ingested":1000,"skipped":0}`.
  const big = validateArray(Array.from({ length: 3 }, (_, i) => ({ type: `t${i}` })), ITEM, "events", { max: 2 });
  assert.equal(big.ok, false);
  const capped = await errorOf(big);
  assert.match(capped.error, /holds 3 entries; at most 2/);

  const entry = await errorOf(validateArray([null], ITEM, "events"));
  assert.match(entry.error, /events\[0\] must be a JSON object, got null/);
});

test("boolFlag is for the flag that is not a column", async () => {
  assert.deepEqual(boolFlag(undefined, "sync"), { ok: true, value: undefined });
  assert.deepEqual(boolFlag(null, "sync"), { ok: true, value: undefined });
  assert.deepEqual(boolFlag(true, "sync"), { ok: true, value: true });
  assert.deepEqual(boolFlag(false, "sync"), { ok: true, value: false });
  assert.equal(boolFlag("no", "sync").ok, false, "the route honoured only `=== false`, so \"no\" meant inline");
  const words = await errorOf(boolFlag("no", "sync"));
  assert.match(words.error, /sync must be true or false, got a string — send it unquoted/);
});

test("readJson turns the two 500s into two 400s", async () => {
  const req = (text: string, type = "application/json") =>
    new Request("http://localhost/api/x", { method: "POST", body: text, headers: { "content-type": type } });

  assert.match(((await errorOf(await readJson(req("prose")))).error), /not valid JSON/);
  assert.match(((await errorOf(await readJson(req("[1,2]")))).error), /must be a JSON object, got an array/);
  assert.equal((await readJson(req('{"name":"ok"}'))).ok, true);
});
