/**
 * How many events one metric computation may read.
 *
 * The number is a memory bound, not a product limit: `computeMetric` takes the
 * event list in memory, and an unbounded range on a busy workspace would take
 * the process down. The bound is only honest if hitting it is visible — see
 * `assertWindowComplete` — because a count computed from the first 50,000 rows
 * of a 90,000-row range is not a count of that range, and a chart cannot tell
 * the difference.
 */
export const MAX_METRIC_EVENTS = 50_000;

export class EventWindowTooLargeError extends Error {
  readonly max: number;

  constructor(max: number) {
    super(
      `This range holds more than ${max.toLocaleString("en-US")} events. ` +
        "Narrow the range and try again — answering from part of the window would not be the metric.",
    );
    this.name = "EventWindowTooLargeError";
    this.max = max;
  }
}

/**
 * `loadEvents` asks the database for `max + 1` rows on purpose. If the extra
 * row exists, the range is larger than the computation is allowed to read and
 * the request has to fail; returning the rows it did get would answer a
 * different question than the one asked, with no field saying so.
 */
export function assertWindowComplete(rowCount: number, max = MAX_METRIC_EVENTS): void {
  if (rowCount > max) throw new EventWindowTooLargeError(max);
}
