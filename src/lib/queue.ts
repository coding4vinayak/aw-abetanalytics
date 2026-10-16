import { Queue, Worker, Job } from "bullmq";
import IORedis from "ioredis";
// Type-only, so it does not close a cycle at runtime: `billing-jobs` imports this
// file for `queues`/`enqueue`, and this file needs the payload shapes its billing
// Worker dispatches on. A value import here would be a cycle at module load.
import type { CancellationData, TrialNudgeData } from "./billing-jobs";

const connection = new IORedis(process.env.REDIS_URL || "redis://localhost:6379", {
  maxRetriesPerRequest: null,
  lazyConnect: true,
  // Fail fast when Redis is down: without this, commands buffer forever and
  // every request that enqueues hangs instead of answering 503.
  enableOfflineQueue: false,
});

/** Thrown when a job cannot be enqueued because Redis is unreachable. */
export class QueueUnavailableError extends Error {
  readonly status = 503;
  constructor() {
    super("job queue unavailable \u2014 Redis is unreachable; the work is saved, retry shortly");
  }
}

const CONNECTION_FAILURE = /connection is closed|connection is not open|connect econnrefused|connect etimedout|stream disconnected|loading/i;

/**
 * queues.X.add that throws QueueUnavailableError (instead of hanging or
 * leaking driver errors) when Redis is down. Genuine job errors propagate
 * untouched. API routes translate QueueUnavailableError to 503.
 */
export async function enqueue<T extends object>(
  queue: Queue,
  name: string,
  data: T,
  opts?: Parameters<Queue["add"]>[2],
): Promise<Job> {
  try {
    return await queue.add(name, data, opts);
  } catch (error) {
    if (error instanceof Error && CONNECTION_FAILURE.test(error.message)) throw new QueueUnavailableError();
    throw error;
  }
}

/**
 * The queue's BullMQ *name* is its Redis key prefix (`bull:<name>:…`), so on a shared
 * Redis it is the only thing saying whose jobs these are (§27 found the collision that
 * way, through `bull:runs:*`). The name is deliberately unchanged here: renaming it
 * orphans the `bull:snapshots:*` keyspace that already has jobs in it, which is a
 * stored-state decision (#51) rather than a side effect of a shutdown fix. What this
 * file does change is *when* it is constructed.
 *
 * Named once and used by both the Queue and the Worker, because the two must agree: a
 * name that drifts between them enqueues into a queue nothing drains, and that fails
 * silently. `shared/check-queues.sh` reads both across the portfolio.
 */
export const SNAPSHOTS_QUEUE = "snapshots";

/**
 * Built on first touch, not at import, because `new Queue()` is not inert. Handed a
 * lazy-connect client it opens that connection on the next tick and writes
 * `bull:<name>:meta` before anything calls `add()`. Measured against this app before
 * the change: a script whose only act was `import("./src/lib/queue.ts")` was still
 * alive at the 30s timeout (rc=124) and had left exactly one key —
 * `bull:snapshots:meta` — in the scratch db 13 it pointed at. Dev `REDIS_URL` defaults
 * to db 0, so importing this module from a unit test wrote into live dev state, which
 * is why `tsx --test` could not be given a queue test at all. See §8.26.7 and §8.27.
 *
 * The name stays exactly where `shared/check-queues.sh` reads it — the first argument
 * of the Queue construction — so memoising does not move the asserted fact.
 */
const built: { snapshots?: Queue; billing?: Queue } = {};

/** Every Worker this process started, so shutdownWorkers() can actually close them. */
const workers: Worker[] = [];

/**
 * Retention applied to every job this queue creates, as `defaultJobOptions` on the
 * construction (not in `enqueue`) so the paths that add directly are bounded too. Port
 * of the leadgenius convention (#61, §8.33) to this app — #64.
 *
 * `removeOnComplete: true`: this app's `GET /api/health` reads
 * `getJobCounts("waiting", "active", "failed")` and never `completed` (read from
 * `src/app/api/health/route.ts`), so a retained completed job is a Redis key with no
 * reader — the durable record of a snapshot is SQLite, not the queue.
 * `removeOnFail: 100`: a failed job's hash is the only place its payload and stack
 * survive, so failures are kept, bounded to survive a storm without growing forever;
 * it makes the `failed` number "recent failures" rather than cumulative.
 *
 * It is a default: bullmq merges `{ ...defaultJobOptions, ...opts }` per add, so any
 * add naming its own retention still wins.
 */
import { JOB_RETENTION } from "./queue-retention";

export const queues = {
  get snapshots(): Queue {
    return (built.snapshots ??= new Queue(SNAPSHOTS_QUEUE, { connection, defaultJobOptions: JOB_RETENTION }));
  },
  /**
   * Billing mails — a product-prefixed name because this Redis is shared with the
   * rest of the suite and `bull:abetanalytics-billing:…` is the only thing that
   * says whose delayed jobs these are (§27 found that collision through a bare
   * `runs`). `snapshots` predates the convention and keeps its keyspace (#51);
   * this queue is new, so it takes the prefix with no stored state to orphan.
   */
  get billing(): Queue {
    return (built.billing ??= new Queue("abetanalytics-billing", { connection, defaultJobOptions: JOB_RETENTION }));
  },
};

export async function startWorkers() {
  const { takeSnapshot } = await import("./snapshots");
  const { runBillingJob } = await import("./billing-jobs");

  const worker = new Worker(SNAPSHOTS_QUEUE, async (job: Job) => {
    const { metricId, rangeStart, rangeEnd } = job.data as {
      metricId: string;
      rangeStart: string;
      rangeEnd: string;
    };
    await takeSnapshot(metricId, new Date(rangeStart), new Date(rangeEnd));
  }, { connection, concurrency: 3 });

  workers.push(worker);

  // One email to one owner per job, so the transport is the slow part and there is
  // nothing to gain from running two at once.
  workers.push(new Worker("abetanalytics-billing", async (job: Job) => {
    await runBillingJob(job as Job<TrialNudgeData | CancellationData>);
  }, { connection, concurrency: 1 }));

  console.log("AbetAnalytics workers started");
}

/**
 * Ceiling on how long shutdown waits for in-flight Redis setup to land before tearing
 * the queue down anyway. Two seconds because the only case that waits the full two is a
 * Redis that answers nothing, and that one is already measured clean without a wait.
 */
const SHUTDOWN_SETTLE_MS = 2_000;

/**
 * Graceful shutdown: settle, then Workers, then Queues, then the shared client.
 *
 * The previous body closed the queues and called `connection.quit()`, and each part of
 * that is a crash. All three were measured on the two apps that made this change first
 * (§8.27) and the mechanism is the same shared-client bullmq this app uses, so they are
 * recorded here as the port's reason rather than re-derived per app.
 *
 * (1) `quit()` on a client that never connected throws `Stream isn't writeable and
 *     enableOfflineQueue options is false` — the app sets `enableOfflineQueue: false`
 *     deliberately, so a down Redis fails fast instead of buffering. `disconnect()`
 *     closes what exists and is a no-op otherwise.
 * (2) Closing the client while a Queue's connect is in flight is an *exit*, not a
 *     throw. bullmq attaches `initializing.catch(err => this.emit('error', err))` to
 *     that connect (`redis-connection.js:87`, bullmq 5.81.5) and suppresses the
 *     rejection only inside `close()`'s `if (!this.extraOptions.shared)` branch
 *     (`redis-connection.js:429`), which is never taken when the app hands bullmq a
 *     *shared* client — as all of ours do. Measured rc=1 for a queue touched and closed
 *     in the same tick, rc=0 once the connection had reached `ready`.
 * (3) A Worker is not ready when the client is: its own setup issues commands after the
 *     shared connect lands, so settling only the client still died with a Worker
 *     `select` on a disconnected client (`event_handler.js:41`, measured rc=1). Hence
 *     readiness is awaited on every started object.
 * (4) `waitUntilReady()` must be caught as it is created. Abandoning one that never
 *     lands — the dead-Redis case — is itself an unhandled rejection at ioredis
 *     `Redis.js:220`, which exits 1 like the crash this function exists to avoid.
 *
 * Workers were unreachable before: `startWorkers()` kept them in a local, so there was
 * no way to close one. They are kept in `workers` for that reason.
 *
 * Idempotent — `built` and `workers` are emptied as they close, so a second call has
 * nothing left to close and cannot double-disconnect.
 */
export async function shutdownWorkers() {
  const closingWorkers = workers.splice(0);
  const closingQueues = Object.values(built);
  for (const key of Object.keys(built)) delete (built as Record<string, Queue>)[key];

  await Promise.race([
    Promise.all([...closingQueues, ...closingWorkers].map((item) => item.waitUntilReady().catch(() => undefined))),
    new Promise((resolve) => setTimeout(resolve, SHUTDOWN_SETTLE_MS)),
  ]);

  await Promise.all(closingWorkers.map((worker) => worker.close()));
  await Promise.all(closingQueues.map((queue) => queue.close()));
  connection.disconnect();
}
