import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { withAuth, authedWorkspaceId } from "@/lib/apikeys";
import { resolveAiActor, withAiAuth } from "@/lib/ai-actor";
import { isLlmConfigured } from "@/lib/llm";
import { asRecord } from "@/lib/json";
import { explainMetricChange, relativeChange } from "@/lib/ai-explain";
import { breakdownByDimension, readMetricConfig } from "@/lib/snapshots";
import { metricHeadline, type MetricKind } from "@/lib/metrics";
import { readJson, validateBody } from "@/lib/validate";
import { EXPLAIN_METRIC } from "@/lib/fields";

export const dynamic = "force-dynamic";

/**
 * POST /api/ai/explain-metric
 *
 * Explains the gap between the two most recent snapshots.
 *
 * Two things are deliberate. It reads the **frozen** definition on each
 * snapshot rather than the live metric config, so a metric edited since
 * Tuesday cannot rewrite what the explanation claims about last Tuesday's
 * number. And the per-segment numbers come from `breakdownByDimension`, which
 * runs the metrics engine itself — the breakdown therefore cannot disagree
 * with the headline it is explaining.
 *
 * Read-only: no snapshot, metric, or event is written.
 */
async function POST_impl(request: Request) {
  const read = await readJson(request);
  if (read.error) return read.error;
  const { body } = read;

  const actor = await resolveAiActor(request, {
    claimedWorkspaceId: body.workspaceId,
    // No claim is passed down. This app's `authedWorkspaceId` is the one copy in
    // the family that already refused a non-text claim with a 400 naming the
    // field, and the vendored module now holds that rule — checking it *here* is
    // what lets the other four apps answer the same way without apikeys.ts
    // becoming a vendored file. The bytes this route returns are unchanged
    // (`/tmp/abectorial/n25-abetanalytics-before.txt`).
    keyWorkspaceId: () => authedWorkspaceId(request),
  });

  const checked = validateBody(body, EXPLAIN_METRIC);
  if (checked.error) return checked.error;
  const { metricId, dimension, model } = checked.data;

  // Scoped in the query: another tenant's metric is not found, not fetched-then-refused.
  const metric = await prisma.metric.findFirst({ where: { id: metricId, workspaceId: actor.workspaceId } });
  if (!metric) return NextResponse.json({ error: "metric not found" }, { status: 404 });

  const snapshots = await prisma.snapshot.findMany({
    where: { metricId },
    orderBy: { createdAt: "desc" },
    take: 2,
  });
  if (snapshots.length < 2) {
    return NextResponse.json(
      { error: "Need two snapshots to compare — take another snapshot first." },
      { status: 409 },
    );
  }

  const [current, previous] = snapshots;

  // Headline comes from the frozen result via the engine's own accessor, so a
  // funnel or average reads the same here as it does on the dashboard.
  const currentValue = metricHeadline(asRecord(current.result) as never);
  const previousValue = metricHeadline(asRecord(previous.result) as never);
  if (currentValue === null || previousValue === null) {
    return NextResponse.json(
      { error: "A snapshot in this pair has no numeric headline (empty range?)." },
      { status: 422 },
    );
  }

  const change = relativeChange(currentValue, previousValue);
  const base = {
    current: currentValue,
    previous: previousValue,
    changePct: change === null ? null : Number((change * 100).toFixed(1)),
    window: { from: current.rangeStart, to: current.rangeEnd },
    comparedWith: { from: previous.rangeStart, to: previous.rangeEnd },
  };

  if (!isLlmConfigured()) {
    return NextResponse.json({
      explained: false,
      configured: false,
      ...base,
      reason: "No LLM_API_KEY set — the numbers above are unaffected and still returned.",
    });
  }

  // The frozen definition, not the live config.
  const definition = asRecord(current.definition) as {
    kind?: string;
    config?: unknown;
    name?: string;
  };
  const config = readMetricConfig(definition.config ?? {});

  let breakdown: Awaited<ReturnType<typeof breakdownByDimension>> = [];
  try {
    breakdown = await breakdownByDimension({
      workspaceId: metric.workspaceId,
      kind: (definition.kind ?? metric.kind) as MetricKind,
      config,
      current: { start: current.rangeStart, end: current.rangeEnd },
      previous: { start: previous.rangeStart, end: previous.rangeEnd },
      dimension,
    });
  } catch {
    // A breakdown is an enhancement; the headline comparison is the answer.
    breakdown = [];
  }

  const explanation = await explainMetricChange({
    metric: { name: definition.name ?? metric.name, kind: definition.kind ?? metric.kind },
    current: { value: currentValue, from: String(current.rangeStart), to: String(current.rangeEnd) },
    previous: {
      value: previousValue,
      from: String(previous.rangeStart),
      to: String(previous.rangeEnd),
    },
    breakdown,
    model,
  });

  if (!explanation) {
    return NextResponse.json(
      { explained: false, ...base, reason: "The model was unreachable or returned nothing usable." },
      { status: 502 },
    );
  }

  return NextResponse.json({
    explained: true,
    ...base,
    breakdown,
    explanation: {
      summary: explanation.summary,
      contributors: explanation.contributors,
      hypotheses: explanation.hypotheses,
      recommendation: explanation.recommendation,
      confidence: explanation.confidence,
    },
    usage: explanation.usage,
    model: explanation.model,
    note: "Reading only — snapshots, metrics and events were not modified.",
  });
}

export const POST = withAuth(withAiAuth(POST_impl));
