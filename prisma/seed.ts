import crypto from "crypto";
import { prisma } from "../src/lib/db";
import { takeSnapshot } from "../src/lib/snapshots";
import { mintApiKey } from "../src/lib/apikeys";

/**
 * Create the demo row only if it is not there yet. Metric, Dashboard and
 * AlertRule have no unique constraint on name, so this cannot be an upsert —
 * the lookup is the findFirst and the demo workspace is the scope. Without it,
 * every `npm run db:seed` added another copy of the demo data and another 106
 * events.
 */
async function once<T>(label: string, find: () => Promise<T | null>, create: () => Promise<T>): Promise<T> {
  const existing = await find();
  if (existing) {
    console.log(`Already present: ${label}`);
    return existing;
  }
  const created = await create();
  console.log(`Created: ${label}`);
  return created;
}

async function main() {
  console.log("Seeding AbetAnalytics...");

  const workspace = await prisma.workspace.upsert({
    where: { slug: "demo" },
    update: {},
    create: { name: "Demo Workspace", slug: "demo" },
  });
  console.log("Workspace:", workspace.id);

  const rangeStart = new Date("2026-03-01T00:00:00Z");
  const rangeEnd = new Date("2026-04-01T00:00:00Z");

  // 30 days of funnel traffic: 60 visits, 30 signups, 12 payments.
  const events: { type: string; occurredAt: Date; dimensions: object; value: number | null }[] = [];
  for (let i = 0; i < 60; i++) {
    const day = 1 + (i % 28);
    const user = `user-${i}`;
    events.push({
      type: "visit",
      occurredAt: new Date(`2026-03-${String(day).padStart(2, "0")}T10:00:00Z`),
      dimensions: { user, channel: i % 2 === 0 ? "organic" : "paid" },
      value: null,
    });
    if (i % 2 === 0) {
      events.push({
        type: "signup",
        occurredAt: new Date(`2026-03-${String(day).padStart(2, "0")}T11:00:00Z`),
        dimensions: { user, plan: i % 4 === 0 ? "team" : "pro" },
        value: null,
      });
    }
    if (i % 5 === 0) {
      events.push({
        type: "payment",
        occurredAt: new Date(`2026-03-${String(day).padStart(2, "0")}T12:00:00Z`),
        dimensions: { user, plan: "pro" },
        value: 49 + (i % 3) * 50,
      });
    }
  }
  // The March window is the demo dataset's identity: if it already has events,
  // re-seeding must not double the funnel's counts.
  if ((await prisma.event.count({ where: { workspaceId: workspace.id, occurredAt: { gte: rangeStart, lt: rangeEnd } } })) === 0) {
    await prisma.event.createMany({ data: events.map((e) => ({ ...e, workspaceId: workspace.id })) });
    console.log(`Events: ${events.length}`);
  } else {
    console.log("Already present: March demo events");
  }

  const funnel = await once(
    "metric Trial to paid",
    () => prisma.metric.findFirst({ where: { workspaceId: workspace.id, name: "Trial to paid" } }),
    () => prisma.metric.create({
      data: {
        workspaceId: workspace.id,
        name: "Trial to paid",
        description: "Visit → signup → payment by user id.",
        kind: "funnel",
        config: {
          identityField: "user",
          steps: [{ event: "visit" }, { event: "signup" }, { event: "payment" }],
        },
        status: "ACTIVE",
      },
    }),
  );
  const mrr = await once(
    "metric Payment volume",
    () => prisma.metric.findFirst({ where: { workspaceId: workspace.id, name: "Payment volume" } }),
    () => prisma.metric.create({
      data: {
        workspaceId: workspace.id,
        name: "Payment volume",
        description: "Sum of payment values in range.",
        kind: "sum",
        config: { event: "payment", field: "value" },
        status: "ACTIVE",
      },
    }),
  );
  const signups = await once(
    "metric Signups",
    () => prisma.metric.findFirst({ where: { workspaceId: workspace.id, name: "Signups" } }),
    () => prisma.metric.create({
      data: {
        workspaceId: workspace.id,
        name: "Signups",
        description: "Signup events in range.",
        kind: "count",
        config: { event: "signup" },
        status: "ACTIVE",
      },
    }),
  );
  console.log("Metrics:", funnel.id, mrr.id, signups.id);

  // A snapshot is an immutable answer for one range, so the demo takes exactly
  // one per metric per month rather than one per seed run.
  if ((await prisma.snapshot.count({ where: { metricId: funnel.id, rangeStart, rangeEnd } })) === 0) {
    const { result, headline } = await takeSnapshot(funnel.id, rangeStart, rangeEnd);
    console.log("Seed snapshot:", JSON.stringify(result), "headline:", headline);
  } else {
    console.log("Already present: March funnel snapshot");
  }

  await once(
    "dashboard Growth overview",
    () => prisma.dashboard.findFirst({ where: { workspaceId: workspace.id, name: "Growth overview" } }),
    () => prisma.dashboard.create({
      data: {
        workspaceId: workspace.id,
        name: "Growth overview",
        description: "Funnel, volume, signups.",
        layout: [
          { metricId: funnel.id, title: "Trial to paid" },
          { metricId: mrr.id, title: "Payment volume" },
          { metricId: signups.id, title: "Signups" },
        ],
      },
    }),
  );

  await once(
    "alert rule Funnel conversion dropped",
    () => prisma.alertRule.findFirst({ where: { workspaceId: workspace.id, name: "Funnel conversion dropped" } }),
    () => prisma.alertRule.create({
      data: {
        workspaceId: workspace.id,
        metricId: funnel.id,
        name: "Funnel conversion dropped",
        operator: "lt",
        threshold: 0.1,
        webhookUrl: "https://example.com/hooks/funnel",
        secret: crypto.randomBytes(32).toString("hex"),
        isActive: true,
      },
    }),
  );

  
  // Demo API key for smoke tests and the live demo. The plaintext prints once
  // here and is never stored — copy it into smoke scripts, then rotate it.
  await prisma.apiKey.deleteMany({ where: { workspaceId: workspace.id, name: "Demo key" } });
  const demoKey = await mintApiKey(workspace.id, "Demo key");
  console.log("Demo key (copy now, never shown again):", demoKey.plaintext);
console.log("Seeding complete!");
  console.log(`Workspace: demo (${workspace.id})`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
