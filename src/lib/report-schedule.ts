/**
 * When a weekly report is sent.
 *
 * This file is deliberately pure: no database, no clock, no network. It is the
 * part of the feature that has to be *right* — "every Monday at 08:00" is a
 * promise, and a promise that drifts by an hour twice a year because the box
 * runs on UTC is a broken promise. Everything here is therefore expressed in
 * the schedule's own timezone, and every function takes the current time as an
 * argument so the same input always gives the same output.
 *
 * The three ideas it rests on:
 *
 * 1. **A local wall-clock time is not a UTC time.** "08:00 in Europe/Berlin" is
 *    a different instant in January and in July. The helpers here convert
 *    between the two using the zone's own offset, so the *local* hour is what
 *    stays fixed across a DST change — which is what a person means.
 * 2. **An occurrence is identified by its instant.** `periodKey` is that
 *    instant's ISO form, and it is the idempotency key: a schedule that has
 *    already delivered the 2026-10-20T08:00:00.000Z occurrence will not deliver
 *    it again, no matter how many times the tick runs or how many instances
 *    run it.
 * 3. **A schedule starts when it was made.** A schedule created after its slot
 *    has passed waits for the next one. Otherwise every new schedule would
 *    fire a "report" covering a window that ended before it existed.
 */

/** How many times one occurrence may be attempted before it is given up on. */
export const MAX_REPORT_ATTEMPTS = 3;

/** The parts of an instant as seen in a particular timezone. */
export interface LocalParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number;
  second: number;
  /** 0 = Sunday .. 6 = Saturday, in the schedule's own week. */
  weekday: number;
}

/** The fields of a schedule that decide *when* it fires. */
export interface ScheduleShape {
  /** 0 = Sunday .. 6 = Saturday, in `timezone`. */
  dayOfWeek: number;
  /** Local hour of the day, 0-23. */
  hour: number;
  /** IANA zone name, e.g. "Europe/Berlin". */
  timezone: string;
  /** How many days back the reported window reaches. */
  windowDays: number;
  isEnabled: boolean;
  /** The occurrence already delivered, as an ISO instant. */
  lastPeriod: string | null;
  /** The occurrence last attempted, successful or not. */
  lastAttemptPeriod: string | null;
  /** Attempts made against `lastAttemptPeriod`. */
  attempts: number;
  /** When the schedule was made — occurrences before this are not ours to send. */
  createdAt: Date;
}

/** Whether a string is a timezone this runtime knows. */
export function isValidTimeZone(timezone: unknown): timezone is string {
  if (typeof timezone !== "string" || timezone.length === 0) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

const partsFormatter = (timeZone: string) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

/** The wall-clock parts of an instant, as seen in `timeZone`. */
export function zoneParts(instant: Date, timeZone: string): LocalParts {
  const parts = partsFormatter(timeZone).formatToParts(instant);
  const read = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((p) => p.type === type)?.value);
  const year = read("year");
  const month = read("month");
  const day = read("day");
  return {
    year,
    month,
    day,
    hour: read("hour"),
    minute: read("minute"),
    second: read("second"),
    // The weekday is derived from the local calendar date, not from the
    // instant: a schedule fires on *its* Monday, whatever UTC says that day is.
    weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
  };
}

/**
 * The zone's offset at an instant, in milliseconds.
 *
 * Positive east of Greenwich. It is computed by asking the zone what the
 * instant looks like locally and comparing that to the instant itself, which
 * is the only definition of an offset that stays correct across DST.
 */
export function zoneOffsetMs(instant: Date, timeZone: string): number {
  const p = zoneParts(instant, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - instant.getTime();
}

/**
 * The instant of a local wall-clock time in a zone.
 *
 * The offset depends on the instant and the instant depends on the offset, so
 * this iterates: guess in UTC, ask the zone what it thinks that guess is, and
 * correct. Two rounds settle it, including on a DST changeover — and on a
 * local time that does not exist (the hour a spring-forward skips) it lands on
 * the instant just before the jump, which is the honest answer for a time that
 * never happens.
 */
export function instantForLocal(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const wall = Date.UTC(year, month - 1, day, hour, minute, 0);
  let guess = wall;
  for (let i = 0; i < 3; i++) {
    const next = wall - zoneOffsetMs(new Date(guess), timeZone);
    if (next === guess) break;
    guess = next;
  }
  return new Date(guess);
}

/** A calendar date, moved by whole days. Plain UTC arithmetic on the date. */
function addDays(date: { year: number; month: number; day: number }, days: number) {
  const moved = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: moved.getUTCFullYear(), month: moved.getUTCMonth() + 1, day: moved.getUTCDate() };
}

const weekdayOf = (date: { year: number; month: number; day: number }) =>
  new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();

/**
 * The next occurrence strictly after `now`.
 *
 * The weekly occurrence is the only shape this product offers, and it is the
 * shape people mean: "every Monday at 8". A daily or monthly schedule would
 * need its own period arithmetic, and a half-built version of that is worse
 * than none.
 */
export function nextRunAt(shape: ScheduleShape, now: Date): Date {
  const local = zoneParts(now, shape.timezone);
  for (let i = 0; i <= 7; i++) {
    const day = addDays(local, i);
    if (weekdayOf(day) !== shape.dayOfWeek) continue;
    const candidate = instantForLocal(day.year, day.month, day.day, shape.hour, 0, shape.timezone);
    if (candidate.getTime() > now.getTime()) return candidate;
  }
  // Unreachable: a week always contains the weekday we are looking for.
  return new Date(now.getTime() + 7 * 24 * 3600 * 1000);
}

/**
 * The most recent occurrence at or before `now`, or null when the schedule was
 * made after it.
 */
export function lastOccurrenceAtOrBefore(shape: ScheduleShape, now: Date): Date | null {
  const local = zoneParts(now, shape.timezone);
  for (let i = 0; i <= 7; i++) {
    const day = addDays(local, -i);
    if (weekdayOf(day) !== shape.dayOfWeek) continue;
    const candidate = instantForLocal(day.year, day.month, day.day, shape.hour, 0, shape.timezone);
    if (candidate.getTime() > now.getTime()) continue;
    // A schedule does not own occurrences that predate it.
    if (candidate.getTime() < shape.createdAt.getTime()) return null;
    return candidate;
  }
  return null;
}

/** The idempotency key for an occurrence: its instant, in ISO form. */
export function periodKey(occurrence: Date): string {
  return occurrence.toISOString();
}

/** The window a report covers: the `windowDays` before the occurrence. */
export function reportWindow(occurrence: Date, windowDays: number): { start: Date; end: Date } {
  return {
    start: new Date(occurrence.getTime() - windowDays * 24 * 3600 * 1000),
    end: occurrence,
  };
}

/**
 * The occurrence a schedule owes right now, or null when it owes none.
 *
 * Three ways to owe nothing: the schedule is off; the occurrence was already
 * delivered; or it has been attempted too many times and was given up on.
 * Everything else is due — including a schedule whose slot was missed while
 * the app was down, which is then caught up on the next tick.
 */
export function dueOccurrence(
  shape: ScheduleShape,
  now: Date,
): { period: string; occurrence: Date } | null {
  if (!shape.isEnabled) return null;

  const occurrence = lastOccurrenceAtOrBefore(shape, now);
  if (!occurrence) return null;

  const period = periodKey(occurrence);
  if (shape.lastPeriod === period) return null;
  if (shape.lastAttemptPeriod === period && shape.attempts >= MAX_REPORT_ATTEMPTS) return null;

  return { period, occurrence };
}
