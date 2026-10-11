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
      await assertAllowedTarget(rule.webhookUrl, "webhookUrl");
      const res = await fetch(rule.webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          rule: { id: rule.id, name: rule.name, operator: rule.operator, threshold: rule.threshold },
          metricId,
          snapshotId,
          value,
          at: new Date().toISOString(),
        }),
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
