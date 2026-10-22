/**
 * The API contract check: src/lib/openapi.ts against the route handlers.
 *
 * A spec is a second description of the same thing, and second descriptions
 * rot. This one cannot, because every claim is read back out of the source
 * that serves it:
 *
 *   · every operation in the spec has a route that answers it, and every route
 *     that answers is in the spec — a documented call that 404s, and a shipped
 *     call nobody can discover, have both bitten this suite
 *   · every request body is compared with the app's own declared field table,
 *     so the spec cannot advertise a field the door would refuse, and cannot
 *     omit one the door requires
 *   · the auth a route enforces is the auth the spec advertises
 *   · operationIds are unique, and the version is the app's own version
 *
 * Run: npx tsx scripts/check-contract.mts
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import * as fieldTables from "../src/lib/fields";
import { openapiOperations, openapiSpec } from "../src/lib/openapi";
import { VERSION } from "../src/lib/version";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const APP = join(ROOT, "src/app");

/** The spec's own homes — they serve the document, so they are not operations in it. */
const SPEC_ROUTES = new Set(["/api/openapi", "/openapi.json"]);

const passes: string[] = [];
const failures: string[] = [];
const check = (label: string, ok: boolean, detail = "") =>
  (ok ? passes : failures).push(ok ? label : `${label}${detail ? ` — ${detail}` : ""}`);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry === "route.ts") out.push(full);
  }
  return out;
}

/** `/api/metrics/[id]` → `/api/metrics/{id}` — the spec's path syntax. */
function specPath(file: string): string {
  const rel = relative(APP, dirname(file)).split(/[\\/]/).join("/");
  return `/${rel}`.replace(/\[([^\]]+)\]/g, "{$1}");
}

const VERBS = ["get", "post", "patch", "put", "delete"] as const;
type Verb = (typeof VERBS)[number];

/** The verbs a route file exports, in either style the app uses. */
function verbsOf(source: string): Verb[] {
  const found = new Set<Verb>();
  for (const m of source.matchAll(/export\s+(?:const|async function|function)\s+(GET|POST|PATCH|PUT|DELETE)\b/g)) {
    found.add(m[1].toLowerCase() as Verb);
  }
  for (const m of source.matchAll(/export\s*\{[^}]*\b(GET|POST|PATCH|PUT|DELETE)\b[^}]*\}/g)) {
    found.add(m[1].toLowerCase() as Verb);
  }
  return [...found];
}



/** The field names a table declares, or none when the table does not exist. */
function tableFields(name: string): string[] {
  const table = (fieldTables as unknown as Record<string, Record<string, unknown> | undefined>)[name];
  return table ? Object.keys(table) : [];
}

/**
 * The route's code without its comments.
 *
 * A field named in a comment is not a field the door reads, and a check that
 * believed the comments would pass a body the product has never accepted.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

// ── the routes, read out of the source ────────────────────────────────────
const routes = new Map<string, { verbs: Verb[]; source: string }>();
for (const file of walk(APP)) {
  const path = specPath(file);
  if (SPEC_ROUTES.has(path)) continue;
  const source = readFileSync(file, "utf8");
  const verbs = verbsOf(source);
  if (verbs.length) routes.set(path, { verbs, source });
}

// ── the spec, read out of the file ───────────────────────────────────────
const specPaths = new Map(
  (openapiSpec.paths as Record<string, Record<string, { operationId?: string }>> ? Object.entries(openapiSpec.paths) : []).map(
    ([path, item]) => [path, item as Record<string, { operationId?: string }>],
  ),
);

// · every route that answers is in the spec
for (const [path, route] of routes) {
  const item = specPaths.get(path);
  if (!item) {
    check("every route that answers is in the spec", false, `${path} is not in the contract`);
    continue;
  }
  for (const verb of route.verbs) {
    if (!item[verb]) {
      check("every route that answers is in the spec", false, `${path} ${verb.toUpperCase()} is not in the contract`);
    }
  }
}
check("every route that answers is in the spec", failures.length === 0, failures[0]);

// · every operation in the spec has a route that answers it
const missingRoutes: string[] = [];
for (const [path, item] of specPaths) {
  const route = routes.get(path);
  if (!route) {
    missingRoutes.push(path);
    continue;
  }
  for (const verb of Object.keys(item)) {
    if (!route.verbs.includes(verb as Verb)) {
      missingRoutes.push(`${path} ${verb.toUpperCase()}`);
    }
  }
}
check(
  "every operation in the spec has a route that answers it",
  missingRoutes.length === 0,
  missingRoutes.join(", "),
);

// · the auth a route enforces is the auth the spec advertises
const authProblems: string[] = [];
for (const { path, method, operation } of openapiOperations) {
  const route = routes.get(path);
  if (!route) continue;
  const keyGated = /withAuth\(/.test(route.source);
  const sessionGated = /getSession\(/.test(route.source) && !keyGated;
  if (keyGated && operation.auth !== "key") authProblems.push(`${path} ${method.toUpperCase()} is key-gated but the spec says ${operation.auth}`);
  if (sessionGated && operation.auth !== "session") {
    authProblems.push(`${path} ${method.toUpperCase()} is session-gated but the spec says ${operation.auth}`);
  }
}
check("the auth a route enforces is the auth the spec advertises", authProblems.length === 0, authProblems.join("; "));

// · every request body matches the app's own declared field table
//
// Two halves, and they are different questions. The **table** says what the
// door will accept, so every field in it must be in the spec — an integrator
// who cannot see a field cannot send it. The **route's source** says what the
// door actually reads, so every field in the spec must be read there — a
// field the spec advertises and the door ignores is a promise the first call
// breaks.
//
// The route's comments are stripped first: a field named in a comment is not
// a field the door reads, and a check that believed the comments would pass a
// body the product has never accepted.
const bodyProblems: string[] = [];
for (const { path, method, operation } of openapiOperations) {
  const route = routes.get(path);
  const described = Object.keys(operation.body?.properties ?? {});
  if (route) {
    const code = stripComments(route.source);
    // A route that writes the validated body wholesale — `...checked.data` —
    // reads every field the table declares, even the ones it never names.
    const writesTheTable = /\.\.\.\s*[A-Za-z_$][\w$]*\??\.data/.test(code);
    for (const name of described) {
      if (new RegExp(`\\b${name}\\b`).test(code)) continue;
      if (writesTheTable && operation.fields && tableFields(operation.fields).includes(name)) continue;
      bodyProblems.push(`${path} ${method.toUpperCase()} describes ${name}, which the route never reads`);
    }
  }
  if (!operation.fields) continue;
  const table = (fieldTables as unknown as Record<string, Record<string, { required?: boolean }> | undefined>)[
    operation.fields
  ];
  if (!table) {
    bodyProblems.push(`${path} ${method.toUpperCase()} names the field table ${operation.fields}, which does not exist`);
    continue;
  }
  for (const name of Object.keys(table)) {
    if (!described.includes(name)) {
      bodyProblems.push(`${path} ${method.toUpperCase()} does not describe ${name}, which the door accepts`);
    }
  }
}
check("every request body matches the app's own declared field table", bodyProblems.length === 0, bodyProblems.join("; "));

// · operationIds are unique
const ids = openapiOperations.map((o) => o.operation.id);
const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);
check("operationIds are unique", duplicates.length === 0, duplicates.join(", "));

// · the version is the app's own version
check(
  "the contract's version is the app's own version",
  openapiSpec.info.version === VERSION,
  `the contract says ${openapiSpec.info.version}, the app says ${VERSION}`,
);

// · the document is an OpenAPI 3.1 document with the two security schemes
check("the contract is an OpenAPI 3.1 document", openapiSpec.openapi === "3.1.0", String(openapiSpec.openapi));
check(
  "the contract declares the auth schemes it uses",
  Boolean(openapiSpec.components?.securitySchemes?.apiKey) && Boolean(openapiSpec.components?.securitySchemes?.sessionCookie),
);

for (const label of passes) console.log(`  PASS  ${label}`);
for (const label of failures) console.log(`  FAIL  ${label}`);
console.log(`\n  ${passes.length} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
