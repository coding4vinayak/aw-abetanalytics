import { VERSION } from "./version";

/**
 * The API contract — what an integrator reads, and what the acceptance
 * sweep checks against the routes.
 *
 * A spec is a second description of the same thing, and second descriptions
 * rot. This one cannot: `scripts/check-contract.mts` reads every claim back
 * out of the source that serves it. Every route that answers is in here and
 * every operation here has a route that answers; every request body is
 * compared with the app's own declared field table, so the spec cannot
 * advertise a field the door would refuse; and the version is the app's
 * version, read from the same place the landing page's badge reads it.
 *
 * The bodies are described by hand, but the *shape* of each one is checked
 * against `src/lib/fields.ts` — the tables the routes themselves validate
 * with. A field the door accepts and the spec does not mention is a missing
 * piece of the contract; a field the spec mentions and the door does not
 * accept is a promise the product breaks on the first call.
 */

const API_KEY = [{ apiKey: [] }];
const SESSION = [{ sessionCookie: [] }];
const NONE: Record<string, string[]>[] = [];

type Method = "get" | "post" | "patch" | "put" | "delete";

interface Operation {
  /** A stable name for the call — the operationId an SDK would generate. */
  id: string;
  /** One line, said the way the README says it. */
  summary: string;
  /** The auth the route enforces. */
  auth?: "key" | "session" | "none" | "stripe";
  /** Query parameters, as `[name, description]`. */
  query?: [string, string][];
  /** A JSON body, described as its properties. */
  body?: { description: string; properties: Record<string, { type: string; description: string; required?: boolean }> };
  /** The statuses the route can answer, with what each one carries. */
  responses?: Record<string, string>;
  /** The field table the body is checked against, by name. */
  fields?: string;
}

interface PathItem {
  get?: Operation;
  post?: Operation;
  patch?: Operation;
  put?: Operation;
  delete?: Operation;
}

const securityFor = (auth: Operation["auth"]) =>
  auth === "key" ? API_KEY : auth === "session" ? SESSION : auth === "stripe" ? NONE : NONE;

function op(
  method: Method,
  operation: Operation,
): Record<string, unknown> {
  const parameters = (operation.query ?? []).map(([name, description]) => ({
    name,
    in: "query",
    required: false,
    description,
    schema: { type: "string" },
  }));
  const body = operation.body
    ? {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: Object.fromEntries(
                Object.entries(operation.body.properties).map(([name, shape]) => [
                  name,
                  { type: shape.type, description: shape.description, ...(shape.required ? {} : {}) },
                ]),
              ),
              required: Object.entries(operation.body.properties)
                .filter(([, shape]) => shape.required)
                .map(([name]) => name),
            },
          },
        },
      }
    : undefined;
  const responses = Object.fromEntries(
    Object.entries(operation.responses ?? { "200": "The answer." }).map(([status, description]) => [
      status,
      { description, content: { "application/json": { schema: { type: "object" } } } },
    ]),
  );
  return {
    operationId: operation.id,
    summary: operation.summary,
    tags: [operation.id.split(".")[0]],
    ...(parameters.length ? { parameters } : {}),
    ...(body ? { requestBody: body } : {}),
    responses,
    ...(operation.auth === "key" || operation.auth === "session"
      ? { security: securityFor(operation.auth) }
      : {}),
  };
}

const PATHS: Record<string, PathItem> = {
  "/api/health": {
    get: {
      id: "health.get",
      summary: "Liveness and a database ping. No key needed.",
      auth: "none",
      responses: { "200": "ok, with the queue depths." },
    },
  },
  "/api/events": {
    get: {
      id: "events.list",
      summary: "The workspace's events, newest first.",
      auth: "key",
      query: [
        ["workspaceId", "The workspace to read. Defaults to the key's own."],
        ["type", "One event type, e.g. purchase."],
        ["since", "ISO timestamp — events at or after it."],
        ["until", "ISO timestamp — events before it."],
        ["limit", "1 to 500. Defaults to 50."],
      ],
      responses: { "200": "The events, newest first, with a total." },
    },
    post: {
      id: "events.ingest",
      fields: "EVENT_ITEM",
      summary: "Send one event, or a batch of up to 1000.",
      auth: "key",
      body: {
        description: "One event, or { events: [...] } for a batch.",
        properties: {
          type: { type: "string", description: "The event type — what the metrics read.", required: true },
          occurredAt: { type: "string", description: "ISO timestamp. Defaults to now." },
          value: { type: "number", description: "The number, for sum and average metrics." },
          dimensions: { type: "object", description: "The dimensions a metric filters on." },
          events: { type: "array", description: "A batch of the same shape, up to 1000." },
        },
      },
      responses: { "201": "How many rows were ingested and how many were skipped." },
    },
  },
  "/api/metrics": {
    get: {
      id: "metrics.list",
      summary: "The workspace's metrics, newest first.",
      auth: "key",
      query: [
        ["workspaceId", "The workspace to read. Defaults to the key's own."],
        ["page", "1-based page number."],
        ["limit", "Page size; it caps at 100."],
      ],
      responses: { "200": "The metrics, with a total." },
    },
    post: {
      id: "metrics.create",
      fields: "METRIC_CREATE",
      summary: "Define a metric once.",
      auth: "key",
      body: {
        description: "The metric's name, kind and configuration.",
        properties: {
          name: { type: "string", description: "What the metric is called.", required: true },
          description: { type: "string", description: "What it answers." },
          kind: { type: "string", description: "count, sum, avg, unique or funnel.", required: true },
          config: { type: "object", description: "The event, the field, the filters, the steps." },
          status: { type: "string", description: "ACTIVE or DRAFT." },
        },
      },
      responses: { "201": "The metric, with its frozen definition." },
    },
  },
  "/api/metrics/{id}": {
    get: {
      id: "metrics.get",
      summary: "One metric, with its snapshots.",
      auth: "key",
      query: [
        ["preview", "1 computes the number without persisting a snapshot."],
        ["start", "ISO timestamp — the range the preview covers."],
        ["end", "ISO timestamp — the end of that range."],
      ],
      responses: { "200": "The metric, and the number it computes." },
    },
    patch: {
      id: "metrics.update",
      fields: "METRIC_UPDATE",
      summary: "Edit a metric's name, description, kind or config.",
      auth: "key",
      body: {
        description: "The fields to change.",
        properties: {
          name: { type: "string", description: "A new name." },
          description: { type: "string", description: "A new description." },
          kind: { type: "string", description: "A new kind." },
          config: { type: "object", description: "A new configuration." },
          status: { type: "string", description: "ACTIVE or DRAFT." },
        },
      },
      responses: { "200": "The metric as it now reads." },
    },
    delete: {
      id: "metrics.delete",
      summary: "Delete a metric and its snapshots.",
      auth: "key",
      responses: { "200": "The metric is gone." },
    },
  },
  "/api/metrics/{id}/breakdown": {
    post: {
      id: "metrics.breakdown",
      fields: "BREAKDOWN",
      summary: "Split a metric's movement across one dimension's values.",
      auth: "key",
      body: {
        description: "Two adjacent ranges and the dimension to split by.",
        properties: {
          metricId: { type: "string", description: "The metric to explain.", required: true },
          currentStart: { type: "string", description: "ISO timestamp — the current range's start.", required: true },
          currentEnd: { type: "string", description: "ISO timestamp — the current range's end.", required: true },
          previousStart: { type: "string", description: "ISO timestamp — the earlier range's start.", required: true },
          previousEnd: { type: "string", description: "ISO timestamp — the earlier range's end.", required: true },
          dimension: { type: "string", description: "The dimension to split by. The engine picks one otherwise." },
        },
      },
      responses: { "200": "The segments, ranked by movement." },
    },
  },
  "/api/snapshots": {
    get: {
      id: "snapshots.list",
      summary: "The frozen numbers, newest first.",
      auth: "key",
      query: [
        ["workspaceId", "The workspace to read. Defaults to the key's own."],
        ["metricId", "Only this metric's snapshots."],
      ],
      responses: { "200": "The snapshots, with a total." },
    },
    post: {
      id: "snapshots.create",
      fields: "SNAPSHOT_CREATE",
      summary: "Compute a metric and freeze the number.",
      auth: "key",
      body: {
        description: "The metric and the range to freeze.",
        properties: {
          metricId: { type: "string", description: "The metric to freeze.", required: true },
          rangeStart: { type: "string", description: "ISO timestamp — the range's start.", required: true },
          rangeEnd: { type: "string", description: "ISO timestamp — the range's end.", required: true },
        },
      },
      responses: { "201": "The snapshot, with the number and the definition it was computed from." },
    },
  },
  "/api/snapshots/{id}/share": {
    post: {
      id: "snapshots.share",
      summary: "Mint (or return) a read-only link to a frozen number.",
      auth: "key",
      responses: { "201": "The link, with the capability token." },
    },
    delete: {
      id: "snapshots.unshare",
      summary: "Revoke a shared link — the URL 404s from then on.",
      auth: "key",
      responses: { "200": "The link is revoked." },
    },
  },
  "/api/reports": {
    get: {
      id: "reports.list",
      summary: "The weekly reports, with the next send time.",
      auth: "key",
      responses: { "200": "The reports." },
    },
    post: {
      id: "reports.create",
      fields: "REPORT_CREATE",
      summary: "Schedule a weekly report.",
      auth: "key",
      body: {
        description: "The metric, the address, and the day and hour to send it.",
        properties: {
          metricId: { type: "string", description: "The metric to report.", required: true },
          email: { type: "string", description: "Where the report goes.", required: true },
          dayOfWeek: { type: "string", description: "The day to send on." },
          hour: { type: "string", description: "The hour to send at." },
          timezone: { type: "string", description: "The timezone the hour is in." },
          windowDays: { type: "number", description: "How many days the report reads. 1 to 90." },
        },
      },
      responses: { "201": "The report, with its next send time." },
    },
  },
  "/api/reports/{id}": {
    delete: {
      id: "reports.delete",
      summary: "Cancel a report — deleting the row is the unsubscribe.",
      auth: "key",
      responses: { "200": "The report is cancelled." },
    },
  },
  "/api/reports/{id}/send": {
    post: {
      id: "reports.send",
      summary: "Send a report now, to check the address works.",
      auth: "key",
      responses: { "200": "The report was sent, and what it said." },
    },
  },
  "/api/dashboards": {
    get: {
      id: "dashboards.list",
      summary: "The workspace's dashboards.",
      auth: "key",
      query: [["workspaceId", "The workspace to read. Defaults to the key's own."]],
      responses: { "200": "The dashboards." },
    },
    post: {
      id: "dashboards.create",
      fields: "DASHBOARD_CREATE",
      summary: "Create a dashboard of metrics.",
      auth: "key",
      body: {
        description: "The dashboard's name and the metrics it shows.",
        properties: {
          name: { type: "string", description: "What the dashboard is called.", required: true },
          description: { type: "string", description: "What it is for." },
          layout: { type: "array", description: "The cards it shows — each names a metric in this workspace.", required: true },
        },
      },
      responses: { "201": "The dashboard." },
    },
  },
  "/api/dashboards/{id}": {
    get: {
      id: "dashboards.get",
      summary: "One dashboard, with its metrics.",
      auth: "key",
      responses: { "200": "The dashboard." },
    },
    patch: {
      id: "dashboards.update",
      fields: "DASHBOARD_UPDATE",
      summary: "Edit a dashboard.",
      auth: "key",
      body: {
        description: "The fields to change.",
        properties: {
          name: { type: "string", description: "A new name." },
          description: { type: "string", description: "A new description." },
          layout: { type: "array", description: "The cards it shows." },
        },
      },
      responses: { "200": "The dashboard as it now reads." },
    },
    delete: {
      id: "dashboards.delete",
      summary: "Delete a dashboard.",
      auth: "key",
      responses: { "200": "The dashboard is gone." },
    },
  },
  "/api/alerts": {
    get: {
      id: "alerts.list",
      summary: "The alert rules, with their signing secret previewed.",
      auth: "key",
      query: [
        ["workspaceId", "The workspace to read. Defaults to the key's own."],
        ["metricId", "Only this metric's rules."],
      ],
      responses: { "200": "The rules." },
    },
    post: {
      id: "alerts.create",
      fields: "ALERT_CREATE",
      summary: "Create an alert rule.",
      auth: "key",
      body: {
        description: "The rule's condition and where it goes.",
        properties: {
          metricId: { type: "string", description: "The metric to watch.", required: true },
          name: { type: "string", description: "What the rule is called.", required: true },
          operator: { type: "string", description: "lt, lte, gt, gte or eq." },
          threshold: { type: "number", description: "The number to compare against.", required: true },
          webhookUrl: { type: "string", description: "Where the alert goes by webhook.", required: true },
          isActive: { type: "boolean", description: "Whether the rule fires at all." },
        },
      },
      responses: { "201": "The rule, with its signing secret returned once." },
    },
  },
  "/api/alerts/{id}": {
    get: {
      id: "alerts.get",
      summary: "One rule, and what it has fired.",
      auth: "key",
      query: [["events", "1 includes the firing history and its delivery receipts."]],
      responses: { "200": "The rule." },
    },
    patch: {
      id: "alerts.update",
      fields: "ALERT_UPDATE",
      summary: "Edit a rule.",
      auth: "key",
      body: {
        description: "The fields to change.",
        properties: {
          name: { type: "string", description: "A new name." },
          operator: { type: "string", description: "A new operator." },
          threshold: { type: "number", description: "A new threshold." },
          webhookUrl: { type: "string", description: "A new webhook address." },
          isActive: { type: "boolean", description: "Whether the rule still fires." },
          rotateSecret: { type: "boolean", description: "1 issues a new signing secret." },
        },
      },
      responses: { "200": "The rule as it now reads." },
    },
    delete: {
      id: "alerts.delete",
      summary: "Delete a rule.",
      auth: "key",
      responses: { "200": "The rule is gone." },
    },
  },
  "/api/webhooks": {
    get: {
      id: "webhooks.list",
      summary: "The outbound subscriptions, with their signing secret previewed.",
      auth: "key",
      query: [["workspaceId", "The workspace to read. Defaults to the key's own."]],
      responses: { "200": "The subscriptions." },
    },
    post: {
      id: "webhooks.create",
      fields: "WEBHOOK_CREATE",
      summary: "Subscribe to events.",
      auth: "key",
      body: {
        description: "Where to deliver, and which events.",
        properties: {
          url: { type: "string", description: "Where the deliveries go.", required: true },
          events: { type: "array", description: "The event names to deliver." },
        },
      },
      responses: { "201": "The subscription, with the signing secret returned once." },
    },
  },
  "/api/webhooks/{id}": {
    get: {
      id: "webhooks.get",
      summary: "One subscription.",
      auth: "key",
      responses: { "200": "The subscription." },
    },
    patch: {
      id: "webhooks.update",
      fields: "WEBHOOK_PATCH",
      summary: "Edit a subscription's address, events or state.",
      auth: "key",
      body: {
        description: "The fields to change.",
        properties: {
          url: { type: "string", description: "A new address." },
          events: { type: "array", description: "A new set of event names." },
          isActive: { type: "boolean", description: "Whether it still delivers." },
        },
      },
      responses: { "200": "The subscription as it now reads." },
    },
    delete: {
      id: "webhooks.delete",
      summary: "Unsubscribe.",
      auth: "key",
      responses: { "200": "The subscription is gone." },
    },
  },
  "/api/ai/explain-metric": {
    post: {
      id: "ai.explainMetric",
      fields: "EXPLAIN_METRIC",
      summary: "Explain a metric's movement in plain words.",
      auth: "key",
      body: {
        description: "The metric and the two ranges to compare.",
        properties: {
          metricId: { type: "string", description: "The metric to explain.", required: true },
          dimension: { type: "string", description: "The dimension to split the movement by." },
          model: { type: "string", description: "The model to write the explanation with." },
        },
      },
      responses: { "200": "The explanation, or why there is none." },
    },
  },
  "/api/example-data": {
    post: {
      id: "exampleData.load",
      summary: "Load the example week — one click, removable again.",
      auth: "session",
      responses: { "201": "What was loaded." },
    },
    delete: {
      id: "exampleData.remove",
      summary: "Take the example data away.",
      auth: "session",
      responses: { "200": "How many rows went." },
    },
  },
  "/api/export": {
    get: {
      id: "export.workspace",
      summary: "The whole workspace as one JSON file.",
      auth: "session",
      responses: { "200": "The workspace." },
    },
  },
  "/api/export/snapshots": {
    get: {
      id: "export.snapshots",
      summary: "The frozen numbers as a board-pack CSV.",
      auth: "session",
      responses: { "200": "The CSV." },
    },
  },
  "/api/export/events": {
    get: {
      id: "export.events",
      summary: "The raw events as a streamed CSV.",
      auth: "session",
      responses: { "200": "The CSV." },
    },
  },
  "/api/billing/checkout": {
    post: {
      id: "billing.checkout",
      summary: "Start a subscription.",
      auth: "session",
      body: {
        description: "The plan to buy.",
        properties: {
          plan: { type: "string", description: "monthly or annual." },
        },
      },
      responses: { "200": "The checkout URL." },
    },
  },
  "/api/billing/portal": {
    post: {
      id: "billing.portal",
      summary: "Open the billing portal — where a plan is changed or cancelled.",
      auth: "session",
      responses: { "200": "The portal URL." },
    },
  },
  "/api/billing/webhook": {
    post: {
      id: "billing.webhook",
      summary: "Stripe's own callback. Signed, not called with a key.",
      auth: "stripe",
      responses: { "200": "The event was recorded." },
    },
  },
};

export const openapiSpec = {
  openapi: "3.1.0",
  info: {
    title: "AbetAnalytics API",
    version: VERSION,
    description:
      "Product analytics on your own data: send events, define a metric once, freeze the number with the definition it was computed from, and share it with anyone without an account.",
    contact: { name: "Abetworks", email: "support@abetworks.in" },
    license: { name: "Proprietary" },
  },
  servers: [{ url: "https://analytics.abetworks.in" }],
  paths: Object.fromEntries(
    Object.entries(PATHS).map(([path, item]) => [
      path,
      Object.fromEntries(
        Object.entries(item)
          .filter(([method]) => ["get", "post", "patch", "put", "delete"].includes(method))
          .map(([method, operation]) => [method, op(method as Method, operation as Operation)]),
      ),
    ]),
  ),
  components: {
    securitySchemes: {
      apiKey: {
        type: "http",
        scheme: "bearer",
        description: "A workspace API key, as 'Authorization: Bearer <key>' or 'x-api-key: <key>'.",
      },
      sessionCookie: {
        type: "apiKey",
        in: "cookie",
        name: "abetworks_session",
        description: "The signed-in browser session — for the routes a person's own workspace uses.",
      },
    },
  },
};

/** The operations, flattened: what the contract check reasons about. */
export const openapiOperations: { path: string; method: Method; operation: Operation }[] =
  Object.entries(PATHS).flatMap(([path, item]) =>
    Object.entries(item).map(([method, operation]) => ({
      path,
      method: method as Method,
      operation: operation as Operation,
    })),
  );
