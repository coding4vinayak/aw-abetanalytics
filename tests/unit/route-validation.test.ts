// Every handler that reads a request body must validate it against a table
// declared in `src/lib/fields.ts`.
//
// Why this is a structural test and not only a probe: the probe measured what
// the routes do today, and a route added next month will not be in it. A handler
// that reaches `body.threshold` without a table is exactly the code this round
// removed, and the only durable statement about it is "a file in this repo reads
// a body and does not validate it, so name the file or wire the table."
//
// The scanner is shared with `route-auth.test.ts` (see `route-handlers.ts`) and
// is the part to distrust: it has been wrong three different ways in this family,
// so the reader count below is measured rather than assumed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { collectHandlers, schemaArgs, unresolvedTailCalls } from "./route-handlers";
import * as FIELDS from "../../src/lib/fields";

/** A handler that gets a parsed JSON body from the request, one way or another. */
const READS_A_BODY = /readJson\s*\(|\brequest\.json\s*\(\s*\)/;

/**
 * The three calls that turn a body into checked values. `boolFlag` counts on its
 * own because a route whose only caller-supplied field is a route-control flag
 * (`sync`) has nothing for a table to say.
 */
const VALIDATES = /validateBody\s*\(|validateArray\s*\(|boolFlag\s*\(/;

/**
 * Handlers that read a body and are not on the list above, each with the reason
 * it is acceptable. Adding a line here is the review step, same as PUBLIC is for
 * authentication.
 *
 * Neither of these writes a Prisma row. `checkout` is session-authed, and
 * `priceId` is refused unless it is one of this plan's own prices; `portal`'s
 * `returnUrl` goes through `sameOriginReturnUrl`, which is a same-origin test
 * rather than a field shape, so it has no kind here. Both `catch` a non-JSON
 * body into a 400 rather than a 500.
 */
const UNVALIDATED: Record<string, string[]> = {
  "src/app/api/billing/checkout/route.ts": ["POST"],
  "src/app/api/billing/portal/route.ts": ["POST"],
};

// Measured: `collectHandlers()` over the sixteen route files answers 29 handlers,
// of which 14 read a JSON body — the 10 POSTs and the 4 PATCHes. The billing
// webhook POST reads raw text for its signature, and the 4 DELETEs and the 11
// GETs take their input from the path and the query string — different
// boundaries, not this rule's business.
const MIN_HANDLERS = 24;
const MAX_HANDLERS = 51;
const EXPECTED_BODY_READERS = 14;

function readers() {
  return collectHandlers().filter((h) => READS_A_BODY.test(h.body));
}

test("the scan this test is built on still sees what it saw when it was written", () => {
  const handlers = collectHandlers();
  assert.ok(handlers.length >= MIN_HANDLERS, `${handlers.length} handlers is below the ${MIN_HANDLERS} floor — the scanner stopped seeing something`);
  assert.ok(handlers.length <= MAX_HANDLERS, `${handlers.length} handlers exceeds ${MAX_HANDLERS} — the scanner is double-counting`);
  assert.equal(readers().length, EXPECTED_BODY_READERS, `body readers moved to ${readers().length}; this test's allowlists are keyed to that set`);
});

test("every handler that reads a body validates it", () => {
  const offenders: string[] = [];
  for (const h of readers()) {
    if ((UNVALIDATED[h.file] ?? []).includes(h.method)) continue;
    if (VALIDATES.test(h.body)) continue;
    offenders.push(`${h.file} ${h.method}`);
  }
  assert.deepEqual(offenders, [], `handlers that read a body with no table behind them:\n  ${offenders.join("\n  ")}`);
});

test("UNVALIDATED names handlers that still exist", () => {
  const seen = new Set(collectHandlers().map((h) => `${h.file} ${h.method}`));
  const stale: string[] = [];
  for (const [file, methods] of Object.entries(UNVALIDATED)) {
    for (const method of methods) if (!seen.has(`${file} ${method}`)) stale.push(`${file} ${method}`);
  }
  assert.deepEqual(stale, [], `allowlisted but not found — delete the entry or fix the scanner:\n  ${stale.join("\n  ")}`);
});

test("a body-reading handler is not validating with an ad-hoc type check", () => {
  // `typeof body.threshold !== "number"` answered 422 correctly and is the code
  // this round deleted. It is not a hole — but two ways to say the same rule is
  // how one of them drifts, so a handler that calls validateBody must also import
  // a table, and the table is where the rule lives.
  const offenders: string[] = [];
  for (const h of readers()) {
    if ((UNVALIDATED[h.file] ?? []).includes(h.method)) continue;
    if (!/validateBody\s*\(/.test(h.body)) continue; // boolFlag-only routes
    const src = readFileSync(h.file, "utf8");
    if (!fromFields(src)) offenders.push(`${h.file} ${h.method} validates without importing a declared table`);
  }
  assert.deepEqual(offenders, [], offenders.join("\n"));
});

// The routes' source, not the handlers' resolved bodies: an import is outside
// the body, and the schema argument is read out of the call where it is used.
const ROUTE_FILES = [...new Set(collectHandlers().map((h) => h.file))];
const routeSource = (file: string) => readFileSync(file, "utf8");

/**
 * Where a schema is named: `validateBody(body, TABLE)` puts it in argument 1,
 * `validateItems(value, "name", TABLE)` in argument 2, and both can carry trailing
 * options (`{ requireWrite: true }`, `{ max: 50 }`), so the table is found by position
 * and not by being last. A call the reader gets no table out of comes back `<unread>`
 * and is reported rather than skipped — this app had no rule here at all while the
 * other five read the same calls with two different regexes (§8.44). Measured on
 * arrival: 8 calls, 8 declared tables, nothing inline, nothing unread.
 */
test("a route validates against a declared table, never an inline one", () => {
  const declared = new Set(Object.keys(FIELDS));
  const offenders: string[] = [];
  for (const file of ROUTE_FILES) {
    for (const arg of schemaArgs(routeSource(file))) {
      if (arg.startsWith("{")) offenders.push(`${file} — an inline schema`);
      else if (!declared.has(arg)) offenders.push(`${file} — ${arg} is not exported from lib/fields`);
    }
  }
  assert.deepEqual(offenders, [], `validate calls with no table in lib/fields:\n  ${offenders.join("\n  ")}`);
});

test("every table in fields.ts is referenced by the route it describes", () => {
  const src = readFileSync("src/lib/fields.ts", "utf8");
  const declared = [...src.matchAll(/^export const ([A-Z_]+) =/gm)].map((m) => m[1]);
  assert.ok(declared.length >= 9, `expected at least nine declared tables, found ${declared.length}`);

  const routes = collectHandlers().map((h) => h.file);
  const seen = new Map<string, string[]>();
  for (const file of new Set(routes)) {
    const text = readFileSync(file, "utf8");
    for (const name of declared) if (text.includes(name)) seen.set(name, [...(seen.get(name) ?? []), file]);
  }
  const orphans = declared.filter((name) => !seen.has(name));
  assert.deepEqual(orphans, [], `tables no route imports — either wire them or delete them:\n  ${orphans.join("\n  ")}`);
});

/**
 * A handler whose body is `return helper(request)` validates nothing and writes nothing
 * until the helper is read. The scanner resolves same-file tail calls (§8.41); this asks
 * it, once per handler, whether the callee's block actually came back — so the day the
 * resolution breaks, the rules above fail loudly instead of passing on a thinner body.
 * Vendored mechanism, local assertion: 181 handlers across the six apps, none hidden.
 */
test("no handler hides a same-file helper behind a tail call", () => {
  const hidden = unresolvedTailCalls(collectHandlers());
  assert.deepEqual(hidden, [], `scanned without the function they return:\n  ${hidden.join("\n  ")}`);
});

function fromFields(src: string): boolean {
  return /from\s+"@\/lib\/fields"/.test(src);
}
