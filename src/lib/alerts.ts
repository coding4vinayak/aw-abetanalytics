import crypto from "crypto";
import { prisma } from "./db";
import { assertAllowedTarget } from "./egress";

export type AlertOperator = "gt" | "gte" | "lt" | "lte";

export function checkThreshold(operator: string, value: number, threshold: number): boolean {
  switch (operator) {
    case "gt":
      return value > threshold;
    case "gte":
      return value >= threshold;
    case "lt":
      return value < threshold;
    case "lte":
      return value <= threshold;
    default:
      return false;
  }
}

/**
 * Evaluate every active rule for one metric against a fresh snapshot value,
 * then deliver. Firing records an AlertEvent first, so a webhook timeout
 * never loses the fact that it fired.
 */
export async function evaluateAlertRules(
  workspaceId: string,
  metricId: string,
  snapshotId: string,
  value: number | null,
): Promise<number> {
  if (value === null) return 0;
  const rules = await prisma.alertRule.findMany({ where: { workspaceId, metricId, isActive: true } });
  let fired = 0;

  for (const rule of rules) {
    if (!checkThreshold(rule.operator, value, rule.threshold)) continue;

    const event = await prisma.alertEvent.create({
      data: { workspaceId, ruleId: rule.id, snapshotId, value, delivered: false },
    });

    try {
      // Stringified once, into the exact bytes that are sent and signed. A
      // second stringify for the signature would be a second serialization
      // that agrees today and drifts at the first field whose order or
      // escaping changes — and the drift would look like a forged signature
      // at the receiver, not like a bug here.
      const body = JSON.stringify({
        rule: { id: rule.id, name: rule.name, operator: rule.operator, threshold: rule.threshold },
        metricId,
        snapshotId,
        value,
        at: new Date().toISOString(),
      });
      const signature = crypto.createHmac("sha256", rule.secret).update(body).digest("hex");
      await assertAllowedTarget(rule.webhookUrl, "webhookUrl");
      const res = await fetch(rule.webhookUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Abetanalytics-Signature": signature,
          // The same digest, spelled the way receivers outside this family
          // expect: `sha256=` + hex over the raw body is what an inbound
          // nuCRM plugin webhook verifies natively, so a rule can point at
          // one with no adapter in between. The family header stays what
          // this product's own receivers already read.
          "X-Webhook-Signature": `sha256=${signature}`,
          "User-Agent": "Abetanalytics-Webhook/1.0",
        },
        body,
        signal: AbortSignal.timeout(10000),
      });
      await prisma.alertEvent.update({
        where: { id: event.id },
        data: { delivered: res.ok, ...(res.ok ? {} : { error: `HTTP ${res.status}` }) },
      });
    } catch (error) {
      await prisma.alertEvent.update({
        where: { id: event.id },
        data: { delivered: false, error: error instanceof Error ? error.message : "delivery failed" },
      });
    }

    await prisma.alertRule.update({ where: { id: rule.id }, data: { lastFiredAt: new Date() } });
    fired++;
  }
  return fired;
}

/**
 * The rule as read routes may show it: everything but the signing secret. The
 * secret is returned by the response that creates the rule, and by the PATCH
 * that rotates it — the only two moments a caller needs it — so listing rules
 * never hands out the keys that sign as this product.
 */
export function alertRulePreview<T extends { secret: string }>(
  rule: T,
): Omit<T, "secret"> & { secretPreview: string } {
  const { secret, ...rest } = rule;
  return { ...rest, secretPreview: `${secret.slice(0, 12)}…` };
}
