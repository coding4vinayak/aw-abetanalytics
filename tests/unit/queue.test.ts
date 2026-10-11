// #52, held in place: importing `src/lib/queue.ts` used to connect to Redis.
//
// `new Queue(name, {connection})` is not inert even when the client is
// `lazyConnect: true`. Measured in *this* app, on the module as it was before the
// change (checked out of HEAD into a scratch file, imported with REDIS_URL pointed at
// db 13): the process was still alive at the timeout and had left one key,
// `bull:snapshots:meta`, in the scratch db. Dev `REDIS_URL` defaults to db 0, so
// importing this module from a unit test wrote into live dev state — which is why
// `tests/unit/queue.test.ts` could not exist here until the Queue moved behind a getter
// (§8.26.7: four variants of that import, all rc=124; §8.27: the same fix in abetflow
// and abetagent, where the three teardown crashes were measured).
//
// Two kinds of assertion, labelled as such:
//   source  — scanned from the module text, offline, always runs
//   probe   — runs only when QUEUE_PROBE_URL names a Redis db explicitly, refuses to
//             run against db 0, and then checks the db the connection actually landed
//             on. The last part is not decoration: abetflow's copy of this file assigned
//             `process.env.REDIS_URL` inside the probe test, which runs after the
//             runtime-touch test has already imported the module — so the shared client
//             had long since been built from the unset default, and MONITOR caught the
//             "scratch" probe writing `bull:abetflow-runs:meta` into db 0 while db 13
//             stayed empty. A guard that inspects the URL string instead of the
//             connection is the §8.20 defect again, so the assignment is hoisted above
//             every import and the destination is asserted.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^[\t ]*\/\/.*$/gm, " ");

const queueModule = source("../../src/lib/queue.ts");
const retentionModule = source("../../src/lib/queue-retention.ts");
const instrumentation = source("../../instrumentation.ts");

const probeUrl = process.env.QUEUE_PROBE_URL;
const probeNamesLiveDb = /\/0$/.test(probeUrl ?? "");
// Must happen before anything imports the queue module: `connection` is built from
// REDIS_URL at import time, so assigning it later changes nothing.
if (probeUrl && !probeNamesLiveDb) process.env.REDIS_URL = probeUrl;

// --- name shape ------------------------------------------------------------
// This app's name is `snapshots`, bare. Rule 6 of shared/check-queues.sh asks for a
// product prefix and is scoped to the two apps that were renamed, because renaming here
// would orphan the `bull:snapshots:*` keyspace that already holds jobs — a stored-state
// decision (#51), not something a shutdown fix gets to do quietly. What is pinned here
// is the part that has no such cost: the name is constructible, and Queue and Worker
// take it from the same identifier.
describe("the queue name is constructible and used by both ends", () => {
  it("contains no colon, because bullmq throws on one at construction", () => {
    const name = /export const SNAPSHOTS_QUEUE = "([^"]+)"/.exec(queueModule)?.[1];
    assert.ok(name, "the queue name is where this test can read it");
    assert.ok(!name.includes(":"), `bullmq rejects "${name}" outright (queue-base.js:35)`);
  });

  it("is taken from one const by both the Queue and the Worker", () => {
    assert.match(queueModule, /new Queue\(SNAPSHOTS_QUEUE, \{ connection, defaultJobOptions: JOB_RETENTION \}\)/);
    assert.match(queueModule, /new Worker\(SNAPSHOTS_QUEUE, /);
  });
});

// --- import must stay inert --------------------------------------------------
describe("importing the queue module does not connect to Redis", () => {
  it("builds the Queue inside a getter, not in the object literal", () => {
    const literal = /export const queues = \{([\s\S]*?)\n\};/.exec(queueModule);
    assert.ok(literal, "queues is declared as an object literal");
    assert.match(literal[1], /get snapshots\(\): Queue \{/);
    assert.doesNotMatch(literal[1], /^\s*snapshots: new Queue\(/m);
  });

  it("memoises it, so /api/health polling does not leak one Queue per request", () => {
    assert.match(queueModule, /built\.snapshots \?\?= new Queue\(SNAPSHOTS_QUEUE, \{ connection, defaultJobOptions: JOB_RETENTION \}\)/);
  });

  it("is a lazy accessor on the imported object, at runtime", async () => {
    const { queues } = await import("../../src/lib/queue");
    const descriptor = Object.getOwnPropertyDescriptor(queues, "snapshots");
    assert.equal(typeof descriptor?.get, "function", "queues.snapshots is an accessor");
    assert.equal(descriptor?.value, undefined, "and nothing was built to import it");
  });
});

// --- the queue bounds what it keeps (#64, port of the leadgenius #61 convention) ---
// Measured locally, not inherited: this app's `GET /api/health` reads
// `getJobCounts("waiting", "active", "failed")` (read from src/app/api/health/route.ts) and
// never `completed`, so a completed snapshot's hash is a Redis key with no reader and its
// durable record is SQLite. Failures are the exception — the job hash is the only place a
// failed payload/stack survives — so they are kept, capped. The default sits at construction,
// not in `enqueue`, so it also bounds any direct `queues.snapshots.add`.
describe("the queue declares retention at construction", () => {
  it("names one shared default that drops completed and caps failures", () => {
    assert.match(queueModule, /import \{ JOB_RETENTION \} from "\.\/queue-retention";/);
    assert.match(retentionModule, /export const JOB_RETENTION[^=]*= \{ removeOnComplete: true, removeOnFail: \d+ \};/);
  });

  it("hands that default to the Queue", () => {
    assert.match(queueModule, /new Queue\(SNAPSHOTS_QUEUE, \{ connection, defaultJobOptions: JOB_RETENTION \}\)/);
  });

  it("constructs no queue with the bare `{ connection }` that this convention removes", () => {
    assert.doesNotMatch(queueModule, /new Queue\([A-Za-z_]+, \{ connection \}\)/);
  });

  it("keeps recent failures rather than dropping them — the failed hash is the only record", () => {
    const cap = Number(/removeOnFail: (\d+)/.exec(retentionModule)?.[1] ?? "0");
    assert.ok(cap > 0, `failed jobs are kept, capped at ${cap} — not dropped the way completed are`);
  });
});

// --- the drain ---------------------------------------------------------------
describe("shutdownWorkers closes what startWorkers started", () => {
  it("keeps every Worker, so the drain has a reference to close", () => {
    assert.match(queueModule, /const workers: Worker\[\] = \[\];/);
    assert.match(queueModule, /workers\.push\(worker\);/);
  });

  it("lets in-flight Redis setup land before closing anything", () => {
    const drain = /export async function shutdownWorkers\(\) \{([\s\S]*?)\n\}/.exec(queueModule);
    assert.ok(drain, "shutdownWorkers is defined in this module");
    const body = drain[1];
    assert.ok(
      body.indexOf("waitUntilReady") < body.indexOf(".close()"),
      "waitUntilReady must come first: closing a Queue mid-connect is the crash at redis-connection.js:87",
    );
    assert.ok(
      body.includes("catch(() => undefined)"),
      "and a waitUntilReady that never lands must be caught at creation, or abandoning it is its own unhandled rejection",
    );
  });

  it("disconnects rather than quitting, so a never-connected client does not throw", () => {
    assert.match(queueModule, /connection\.disconnect\(\);/);
    assert.doesNotMatch(queueModule, /connection\.quit\(\)/);
  });
});

// --- who calls it ------------------------------------------------------------
describe("the drain is wired to something", () => {
  it("installs the signal handlers from instrumentation, in production only", () => {
    assert.match(
      instrumentation,
      /if \(process\.env\.NODE_ENV === "production"\) \{[\s\S]*installShutdownHandlers\(\)/,
    );
  });

  it("binds both SIGTERM and SIGINT", () => {
    const shutdown = source("../../src/lib/shutdown.ts");
    assert.match(shutdown, /\["SIGTERM", "SIGINT"\] as const/);
  });
});

// --- probe: only against an explicitly named, non-zero db --------------------
if (probeUrl) {
  const expectedDb = Number(/\/(\d+)$/.exec(probeUrl)?.[1] ?? 0);
  describe("probe: building and draining the queue on a scratch db", () => {
    // A skipped assertion is invisible, so a probe pointed at the live keyspace is a
    // failure first and a skip second — otherwise the run just looks one test shorter.
    it("refuses db 0, which is where dev state lives", () => {
      assert.ok(!probeNamesLiveDb, `QUEUE_PROBE_URL=${probeUrl} names the live db; name a scratch one`);
    });

    it("returns the same Queue on repeated touch, and shuts down without throwing", { skip: probeNamesLiveDb ? "refusing db 0" : false }, async () => {
      const mod = await import("../../src/lib/queue");
      const first = mod.queues.snapshots;
      assert.equal(mod.queues.snapshots, first);

      // The connection's own view of where it went, not the string we handed it.
      const client = await first.waitUntilReady();
      assert.equal((client as unknown as { options?: { db?: number } }).options?.db, expectedDb,
        "the probe must land on the db it was given, not on the import-time default");

      await mod.shutdownWorkers();
      assert.notEqual(mod.queues.snapshots, first, "a second build after shutdown is a fresh Queue");
    });
  });
}
