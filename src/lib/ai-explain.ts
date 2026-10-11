import { completeJson, isLlmConfigured, type LlmUsage } from "./llm";

/**
 * Explain a metric that moved.
 *
 * Analytics teams live on the question "why is this number different from last
 * week". The numbers are already here and already correct — the funnel, the
 * sum, the count. What is missing is a ranked, honest read of the *change*, and
 * that is where a model earns its place: it has the whole event set in front of
 * it at once, which a person staring at six charts does not.
 *
 * The model is told the single most important thing up front: it may only cite
 * dimensions and values that are present in the breakdown it was given. The
 * failure mode this prevents — a confident paragraph inventing a segment that
 * does not exist — is the reason nobody trusts AI analytics.
 */

export interface MetricExplanation {
  /** 2–3 sentences: what moved, and the most likely reason. */
  summary: string;
  /** Ranked contributors, each naming the dimension and its delta. */
  contributors: { dimension: string; segment: string; delta: string; note: string }[];
  /** Alternatives worth ruling out, with how to check each. */
  hypotheses: string[];
  /** What to do about it. */
  recommendation: string;
  confidence: number;
  usage: LlmUsage;
  model: string;
}

const SYSTEM = `You explain movements in product/revenue metrics to the people who own them.

Rules, absolutely:
1. You may ONLY cite dimension values that appear in the breakdown you are
   given. If a segment is not in the data, you may not mention it — not even
   as a possibility. Inventing a segment is the single worst thing you can do.
2. Quote the actual delta numbers you were given. Do not recompute them, do not
   round them into a different story.
3. Separate what the data shows from what it might mean. Put speculation in
   \`hypotheses\`, never in \`summary\`.
4. If the change is within normal variation, say that instead of inventing a
   cause. "This is noise" is a valid and useful answer.
5. No marketing language, no emoji, no advice the data cannot support.

Return JSON: { summary, contributors[], hypotheses[], recommendation, confidence }.
Each contributor: { dimension, segment, delta, note } where delta is copied from the input.`;

export interface ExplainMetricInput {
  metric: { name: string; kind: string };
  current: { value: number; from: string; to: string };
  previous: { value: number; from: string; to: string };
  /** Segment → contribution, already computed by the metrics engine. */
  breakdown: { dimension: string; segment: string; current: number; previous: number }[];
  model?: string;
}

export function relativeChange(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return (current - previous) / previous;
}

export interface ContributorInput {
  dimension?: string;
  segment?: string;
  delta?: string | number;
  note?: string;
}

/**
 * Keep only contributors whose segment actually exists in the breakdown.
 * This is the guard that makes "cite only what you were given" enforceable
 * rather than aspirational: a model that invents `plan=enterprise` when the
 * data only has `plan=free` and `plan=pro` gets that claim dropped on the
 * floor instead of shown to a customer. Exported for unit tests — the single
 * most important property in this file is that this function is strict.
 */
export function onlyKnownSegments(
  contributors: ContributorInput[] | undefined,
  rows: { dimension: string; segment: string }[],
): { dimension: string; segment: string; delta: string; note: string }[] {
  const known = new Set(rows.map((r) => `${r.dimension}=${r.segment}`));
  if (!Array.isArray(contributors)) return [];
  return contributors
    .filter(
      (c): c is { dimension: string; segment: string; delta?: string | number; note?: string } =>
        typeof c?.dimension === "string" &&
        typeof c?.segment === "string" &&
        known.has(`${c.dimension}=${c.segment}`),
    )
    .map((c) => ({
      dimension: c.dimension,
      segment: c.segment,
      delta: typeof c.delta === "number" ? String(c.delta) : (c.delta ?? "—"),
      note: typeof c.note === "string" ? c.note : "",
    }));
}

/**
 * Explain a movement. Returns null when no model is configured or the call
 * fails — a metric is not a question until someone asks it, and an absent
 * explanation is never wrong.
 */
export async function explainMetricChange(
  input: ExplainMetricInput,
): Promise<MetricExplanation | null> {
  if (!isLlmConfigured()) return null;

  const change = relativeChange(input.current.value, input.previous.value);
  const rows = input.breakdown
    .map((r) => ({
      ...r,
      delta: Math.round((r.current - r.previous) * 100) / 100,
      pct: relativeChange(r.current, r.previous),
    }))
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  const user = [
    `Metric: ${input.metric.name} (${input.metric.kind})`,
    `Current:  ${input.current.value} over ${input.current.from} → ${input.current.to}`,
    `Previous: ${input.previous.value} over ${input.previous.from} → ${input.previous.to}`,
    change === null
      ? `Change: previous value was 0, so no percentage is meaningful.`
      : `Change: ${(change * 100).toFixed(1)}% (${Math.round((input.current.value - input.previous.value) * 100) / 100} absolute)`,
    ``,
    `Breakdown (sorted by absolute contribution — cite from these only):`,
    rows.length
      ? rows
          .map(
            (r) =>
              `  - ${r.dimension}=${r.segment}: ${r.previous} → ${r.current} (delta ${r.delta > 0 ? "+" : ""}${r.delta}${
                r.pct === null ? "" : `, ${(r.pct * 100).toFixed(1)}%`
              })`,
          )
          .join("\n")
      : "  (no segments — the metric has no dimensions to break down by)",
  ].join("\n");

  const result = await completeJson<{
    summary?: string;
    contributors?: { dimension?: string; segment?: string; delta?: string | number; note?: string }[];
    hypotheses?: string[];
    recommendation?: string;
    confidence?: number;
  }>(SYSTEM, user, {
    model: input.model,
    schemaHint:
      '{ "summary": string, "contributors": [{ "dimension": string, "segment": string, "delta": string, "note": string }], "hypotheses": string[], "recommendation": string, "confidence": number }',
  });

  if (!result) return null;
  const summary = typeof result.data.summary === "string" ? result.data.summary.trim() : "";
  if (!summary) return null;

  // The strict filter: invented segments are dropped, not shown.
  const contributors = onlyKnownSegments(
    result.data.contributors as ContributorInput[] | undefined,
    rows,
  );

  return {
    summary,
    contributors,
    hypotheses: Array.isArray(result.data.hypotheses)
      ? result.data.hypotheses.filter((h): h is string => typeof h === "string" && h.trim().length > 0)
      : [],
    recommendation:
      typeof result.data.recommendation === "string" ? result.data.recommendation : "",
    confidence:
      typeof result.data.confidence === "number" ? Math.max(0, Math.min(1, result.data.confidence)) : 0.5,
    usage: result.usage,
    model: result.model,
  };
}
