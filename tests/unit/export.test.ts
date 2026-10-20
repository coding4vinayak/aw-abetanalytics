// The export surface, pinned without a database.
//
// The routes are exercised by the route-auth scanner; what this file owns is
// the part a request would not make obvious: the filename cannot carry a
// header, the board pack preserves the frozen definition rather than today's
// metric, user text cannot become a spreadsheet formula, and the JSON builder
// does not quietly select a credential column.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  eventCsvHeader,
  eventCsvRow,
  exportDownloadHeaders,
  exportFilename,
  snapshotCsv,
} from "../../src/lib/export";

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

/** Minimal RFC 4180 reader for one encoded line; CRLF inside a cell is not in these fixtures. */
function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quoted) {
      if (char === '"' && line[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      cells.push(cell);
      cell = "";
    } else {
      cell += char;
    }
  }
  cells.push(cell);
  return cells;
}

function rows(csv: string): string[][] {
  return csv.replace(/\r\n$/, "").split("\r\n").map(parseCsvLine);
}

describe("export filenames", () => {
  it("sanitises a slug before it reaches Content-Disposition", () => {
    const name = exportFilename('Acme "EU"/Ops\r\n', "workspace", new Date("2026-10-20T12:00:00Z"));
    assert.equal(name, "abetanalytics-acme-eu-ops-workspace-2026-10-20.json");
    assert.equal(exportFilename("", "snapshots", new Date("2026-10-20T12:00:00Z")), "abetanalytics-workspace-snapshots-2026-10-20.csv");
    assert.equal(exportFilename("Acme", "events", new Date("2026-10-20T12:00:00Z")), "abetanalytics-acme-events-2026-10-20.csv");
  });

  it("marks every download no-store and nosniff", () => {
    const headers = exportDownloadHeaders("abetanalytics-acme-events-2026-10-20.csv", "text/csv; charset=utf-8");
    assert.equal(headers["content-disposition"], 'attachment; filename="abetanalytics-acme-events-2026-10-20.csv"');
    assert.equal(headers["cache-control"], "no-store");
    assert.equal(headers["x-content-type-options"], "nosniff");
  });
});

describe("the board-pack CSV", () => {
  it("writes one row per frozen snapshot, using the definition as-run", () => {
    const csv = snapshotCsv([
      {
        id: "snap_1",
        metricId: "metric_1",
        rangeStart: new Date("2026-03-01T00:00:00Z"),
        rangeEnd: new Date("2026-04-01T00:00:00Z"),
        definition: { name: "Revenue, \"net\"", kind: "sum", config: { event: "payment" } },
        result: { kind: "sum", value: 1234.5, events: 5 },
        createdAt: new Date("2026-04-01T12:00:00Z"),
        shareCreatedAt: new Date("2026-04-02T09:00:00Z"),
        shareRevokedAt: null,
      },
    ]);

    const [header, row] = rows(csv);
    assert.deepEqual(header, [
      "snapshot_id",
      "metric_id",
      "metric_name",
      "kind",
      "range_start",
      "range_end",
      "taken_at",
      "headline",
      "headline_display",
      "shared",
      "definition_json",
      "result_json",
    ]);
    assert.equal(row[0], "snap_1");
    assert.equal(row[1], "metric_1");
    assert.equal(row[2], 'Revenue, "net"', "the frozen name, not today's metric name");
    assert.equal(row[3], "sum");
    assert.equal(row[4], "2026-03-01T00:00:00.000Z");
    assert.equal(row[5], "2026-04-01T00:00:00.000Z");
    assert.equal(row[6], "2026-04-01T12:00:00.000Z");
    assert.equal(row[7], "1234.5");
    assert.equal(row[8], "1234.5");
    assert.equal(row[9], "yes");
    assert.deepEqual(JSON.parse(row[10]), {
      name: 'Revenue, "net"',
      kind: "sum",
      config: { event: "payment" },
    });
    assert.deepEqual(JSON.parse(row[11]), { kind: "sum", value: 1234.5, events: 5 });
  });

  it("shows a funnel's headline as its overall conversion percentage", () => {
    const csv = snapshotCsv([
      {
        id: "snap_f",
        metricId: "metric_f",
        rangeStart: "2026-03-01T00:00:00.000Z",
        rangeEnd: "2026-04-01T00:00:00.000Z",
        definition: { name: "Trial to paid", kind: "funnel", config: { steps: [] } },
        result: {
          kind: "funnel",
          subjects: 60,
          steps: [
            { event: "visit", count: 60, rateFromFirst: 1, rateFromPrev: 1 },
            { event: "payment", count: 6, rateFromFirst: 0.1, rateFromPrev: 0.1 },
          ],
        },
        createdAt: "2026-04-01T12:00:00.000Z",
        shareCreatedAt: null,
        shareRevokedAt: null,
      },
    ]);

    const row = rows(csv)[1];
    assert.equal(row[3], "funnel");
    assert.equal(row[7], "0.1");
    assert.equal(row[8], "10.0%");
    assert.equal(row[9], "no");
    assert.deepEqual(JSON.parse(row[11]).steps[1], {
      event: "payment",
      count: 6,
      rateFromFirst: 0.1,
      rateFromPrev: 0.1,
    });
  });

  it("prefixes a cell Excel would run as a formula", () => {
    const csv = snapshotCsv([
      {
        id: "snap_2",
        metricId: "metric_2",
        rangeStart: "2026-03-01T00:00:00.000Z",
        rangeEnd: "2026-04-01T00:00:00.000Z",
        definition: { name: "=SUM(A1:A2)", kind: "count" },
        result: { kind: "count", value: 1, events: 1 },
        createdAt: "2026-04-01T12:00:00.000Z",
        shareCreatedAt: null,
        shareRevokedAt: null,
      },
    ]);

    assert.equal(rows(csv)[1][2], "'=SUM(A1:A2)");
  });
});

describe("the raw-event CSV", () => {
  it("has a stable header and writes nullable values as empty cells", () => {
    assert.equal(
      eventCsvHeader(),
      '"id","type","occurred_at","value","dimensions","created_at"\r\n',
    );
    const row = parseCsvLine(eventCsvRow({
      id: "evt_1",
      type: "payment",
      occurredAt: new Date("2026-03-01T12:00:00Z"),
      dimensions: { plan: "pro", note: 'a "quote"' },
      value: null,
      createdAt: new Date("2026-03-01T12:00:01Z"),
    }).replace(/\r\n$/, ""));
    assert.equal(row[0], "evt_1");
    assert.equal(row[1], "payment");
    assert.equal(row[2], "2026-03-01T12:00:00.000Z");
    assert.equal(row[3], "");
    assert.deepEqual(JSON.parse(row[4]), { plan: "pro", note: 'a "quote"' });
    assert.equal(row[5], "2026-03-01T12:00:01.000Z");
  });

  it("treats an event type as user text, not a formula", () => {
    const row = parseCsvLine(eventCsvRow({
      id: "evt_2",
      type: "=HYPERLINK(\"https://example.test\")",
      occurredAt: "2026-03-01T12:00:00.000Z",
      dimensions: null,
      value: 49,
      createdAt: "2026-03-01T12:00:01.000Z",
    }).replace(/\r\n$/, ""));
    assert.equal(row[1], "'=HYPERLINK(\"https://example.test\")");
    assert.equal(row[3], "49", "numeric values stay numeric");
  });
});

describe("the export builder's boundaries", () => {
  const builder = source("../../src/lib/export.ts");

  it("selects content, never credential columns", () => {
    for (const forbidden of [
      "secret: true",
      "shareToken: true",
      "tokenHash: true",
      "hashedKey: true",
      "passwordHash: true",
      "stripeCustomerId: true",
      "stripeSubscriptionId: true",
    ]) {
      assert.equal(builder.includes(forbidden), false, `${forbidden} must not be selected by an export`);
    }
  });

  it("scopes every collection query to the workspace", () => {
    const scoped = builder.match(/where:\s*\{\s*workspaceId/g) ?? [];
    assert.ok(scoped.length >= 9, `only ${scoped.length} workspace-scoped queries found — a query may be exporting another tenant's rows`);
  });

  it("keeps raw events out of the in-memory document and points at the stream", () => {
    assert.ok(builder.includes('download: "/api/export/events"'));
    assert.ok(builder.includes("events: rawEventCount"), "the document carries the count");
    assert.equal(/events:\s*\[/.test(builder), false, "raw event rows must not be embedded as an array");
  });

  it("every export route authenticates, checks the role, and uses the shared headers", () => {
    const routes = [
      "../../src/app/api/export/route.ts",
      "../../src/app/api/export/snapshots/route.ts",
      "../../src/app/api/export/events/route.ts",
    ];
    for (const route of routes) {
      const src = source(route);
      assert.match(src, /getSession\(\)/, `${route} must resolve the browser session`);
      assert.match(src, /canManageRoles\(session\.role\)/, `${route} must refuse a member`);
      assert.match(src, /exportDownloadHeaders/, `${route} must use the no-store download headers`);
    }
  });
});
