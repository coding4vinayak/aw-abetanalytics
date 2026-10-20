import { prisma } from "./db";
import { getEmailSender, renderWeeklyReportEmail } from "./email";
import { asRecord } from "./json";
import { formatMetricHeadline, type MetricResult } from "./metrics";
import { dueOccurrence, nextRunAt, reportWindow, type ScheduleShape } from "./report-schedule";
import { mintSnapshotShare, shareUrl } from "./snapshot-share";
import { takeSnapshot } from "./snapshots";

/**
 * The weekly report: a frozen number, sent on a schedule, to one address.
 *
 * The product promise is "the number the board agreed" — but a number that has
 * to be fetched is a number that gets forgotten. This is the part that makes
 * the promise a habit: the same metric, over the same window, frozen and
 * emailed, with the definition and a read-only link attached, so the person
 * who has to see it can be *sent* it.
 *
 * Three decisions worth naming:
 *
 * 1. **The emailed number is a real snapshot.** It is frozen with the same
 *    definition-as-run every other snapshot gets, and it is shared through the
 *    same revocable read-only link — so the emailed value and the value
 *    anyone opens later cannot drift apart.
 * 2. **A report never re-pages.** The rules are not evaluated for a
 *    report-generated snapshot: the customer may already have snapshotted that
 *    window and been paged about it, and a second page for the same number is
 *    how a monitoring tool gets muted.
 * 3. **The schedule owns the idempotency, not Redis.** `lastPeriod` is the
 *    occurrence already delivered, and it is compared on the row — so a
 *    restart, a second instance, or a retry cannot send the same week twice.
 */

const PRODUCT = "AbetAnalytics";

/** The columns a report row needs. Structurally the Prisma row. */
export type ReportRow = {
  id: string;
  workspaceId: string;
  metricId: string;
  email: string;
  dayOfWeek: number;
  hour: number;
  timezone: string;
  windowDays: number;
  isEnabled: boolean;
  lastPeriod: string | null;
  lastAttemptPeriod: string | null;
  attempts: number;
  lastSentAt: Date | null;
  lastError: string | null;
  createdAt: Date;
};

/** The schedule fields, as the pure module wants them. */
export function toScheduleShape(row: ReportRow): ScheduleShape {
  return {
    dayOfWeek: row.dayOfWeek,
    hour: row.hour,
    timezone: row.timezone,
    windowDays: row.windowDays,
    isEnabled: row.isEnabled,
    lastPeriod: row.lastPeriod,
    lastAttemptPeriod: row.lastAttemptPeriod,
    attempts: row.attempts,
    createdAt: row.createdAt,
  };
}

/**
 * The definition, as one readable line: "sum of purchase.value".
 *
 * It is read from the snapshot's frozen definition, so the emailed line is the
 * definition the number was computed with — not the metric's current config,
 * which may have changed since.
 */
export function describeDefinition(definition: unknown): string {
  const def = asRecord(definition);
  const config = asRecord(def.config);
  const kind = typeof def.kind === "string" ? def.kind : "count";
  const event = typeof config.event === "string" ? config.event : null;
  const field = typeof config.field === "string" ? config.field : null;

  if (kind === "funnel") {
    const steps = Array.isArray(config.steps)
      ? config.steps.map((s) => asRecord(s).event).filter((e): e is string => typeof e === "string")
      : [];
    return steps.length ? `funnel: ${steps.join(" → ")}` : "funnel";
  }

  const base = event ? `${kind} of ${event}` : kind;
  return field ? `${base}.${field}` : base;
}

/** What a caller sees of a schedule. */
export function reportPreview(row: ReportRow & { metric?: { name: string; kind: string } | null }) {
  const shape = toScheduleShape(row);
  return {
    id: row.id,
    metricId: row.metricId,
    metricName: row.metric?.name ?? null,
    email: row.email,
    dayOfWeek: row.dayOfWeek,
    hour: row.hour,
    timezone: row.timezone,
    windowDays: row.windowDays,
    isEnabled: row.isEnabled,
    lastSentAt: row.lastSentAt,
    lastError: row.lastError,
    createdAt: row.createdAt,
    // The next send, in the schedule's own zone. Computed on read, so it is
    // right after a DST change without anything having to be recalculated.
    nextRunAt: row.isEnabled ? nextRunAt(shape, new Date()).toISOString() : null,
  };
}

/**
 * Freeze the number, share it, and send it.
 *
 * One path for both the scheduled send and the manual "send now": the window
 * differs, nothing else does. That is deliberate — a manual send that produced
 * a different email would be a second template to keep honest.
 */
async function deliver(row: ReportRow, occurrence: Date) {
  const { start, end } = reportWindow(occurrence, row.windowDays);

  // `fireAlerts: false` — the rules were already evaluated for this window if
  // the customer snapshotted it, and paging twice for one number is worse than
  // not paging at all.
  const { snapshot, result } = await takeSnapshot(row.metricId, start, end, { fireAlerts: false });

  const share = await mintSnapshotShare({
    id: snapshot.id,
    shareToken: snapshot.shareToken,
    shareCreatedAt: snapshot.shareCreatedAt,
    shareRevokedAt: snapshot.shareRevokedAt,
  });
  const url = shareUrl(share.token);

  const definition = asRecord(snapshot.definition);
  const mail = renderWeeklyReportEmail({
    product: PRODUCT,
    metricName: typeof definition.name === "string" ? definition.name : "Your metric",
    headline: formatMetricHeadline(result as unknown as MetricResult),
    rangeStart: start,
    rangeEnd: end,
    definition: describeDefinition(snapshot.definition),
    shareUrl: url,
  });

  const sent = await getEmailSender().send(row.email, mail.subject, mail.html, mail.text);

  return { snapshotId: snapshot.id, token: share.token, url, channel: sent.channel, subject: mail.subject };
}

/**
 * The tick: send every report that is owed.
 *
 * A schedule is due when its occurrence has passed and that occurrence has not
 * been delivered. The claim on the row is what makes this safe to run from
 * more than one instance: the update is conditional on the state the worker
 * read, so the second worker to arrive finds the row already claimed and
 * sends nothing.
 */
export async function runReportTick(now: Date = new Date()) {
  const rows = await prisma.reportSchedule.findMany({ where: { isEnabled: true } });
  const outcome = { sent: 0, skipped: 0, failed: 0, errors: [] as string[] };

  for (const row of rows as ReportRow[]) {
    const due = dueOccurrence(toScheduleShape(row), now);
    if (!due) {
      outcome.skipped += 1;
      continue;
    }

    // Claim the attempt, conditionally: only the worker that finds the row
    // exactly as it read it gets to send.
    const claimed = await prisma.reportSchedule.updateMany({
      where: {
        id: row.id,
        lastAttemptPeriod: row.lastAttemptPeriod,
        attempts: row.attempts,
      },
      data: { lastAttemptPeriod: due.period, attempts: row.attempts + 1 },
    });
    if (claimed.count === 0) {
      outcome.skipped += 1;
      continue;
    }

    try {
      await deliver(row, due.occurrence);
      await prisma.reportSchedule.update({
        where: { id: row.id },
        data: { lastPeriod: due.period, lastSentAt: new Date(), attempts: 0, lastError: null },
      });
      outcome.sent += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await prisma.reportSchedule.update({ where: { id: row.id }, data: { lastError: message } });
      outcome.failed += 1;
      outcome.errors.push(`${row.id}: ${message}`);
    }
  }

  return outcome;
}

/**
 * Send the report now — the button a customer clicks to find out whether the
 * address works, and the one a demo uses to show the email arriving.
 *
 * It does not touch the schedule's period state: a manual send is not the
 * weekly occurrence, and consuming the period would silently skip the real
 * Monday.
 */
export async function sendReportNow(
  reportId: string,
  now: Date = new Date(),
): Promise<{ ok: true; url: string; channel: string; subject: string } | { ok: false; error: string }> {
  const row = await prisma.reportSchedule.findUnique({ where: { id: reportId } });
  if (!row) return { ok: false, error: "Report not found." };

  try {
    const sent = await deliver(row as ReportRow, now);
    await prisma.reportSchedule.update({
      where: { id: row.id },
      data: { lastSentAt: new Date(), lastError: null },
    });
    return { ok: true, url: sent.url, channel: sent.channel, subject: sent.subject };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await prisma.reportSchedule.update({ where: { id: row.id }, data: { lastError: message } });
    return { ok: false, error: message };
  }
}
