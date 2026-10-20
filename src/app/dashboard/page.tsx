import Link from "next/link";
import { prisma } from "@/lib/db";
import { DashboardShell } from "@/components/dashboard-shell";
import { BreakdownButton } from "@/components/breakdown-modal";
import { ShareSnapshot } from "@/components/share-snapshot";
import { ReportScheduler } from "@/components/report-scheduler";
import { reportPreview } from "@/lib/reports";
import { shareUrl } from "@/lib/snapshot-share";
import { canManageRoles } from "@/lib/roles";
import { ManageBillingButton } from "@/components/manage-billing";
import { resolveWorkspace } from "@/lib/resolve-workspace";
import { signOut } from "@/app/auth-actions";
import { switchWorkspaceAction } from "@/app/member-actions";
import { createFirstKey } from "@/app/key-actions";
import { ApiKeyOnboarding } from "@/components/api-key-onboarding";
import { AiPanel, type AiField } from "@/components/ai-panel";
import { formatMetricHeadline } from "@/lib/metrics";
import type { MetricResult } from "@/lib/metrics";

export const dynamic = "force-dynamic";

function Card({ label, value, sub }: { label: string; value: React.ReactNode; sub?: string }) {
  return (
    <div className="bg-white rounded-2xl shadow-sm p-5">
      <p className="text-xs font-medium uppercase tracking-wide text-gray-500">{label}</p>
      <p className="mt-1 text-2xl font-bold text-gray-900">{value}</p>
      {sub && <p className="mt-1 text-xs text-gray-500">{sub}</p>}
    </div>
  );
}

type SubscriptionState = {
  status: string;
  stripeCustomerId: string;
  stripeCurrentPeriodEnd: Date | null;
} | null;

/**
 * Whole days left before the first charge. During a trial the stored period end
 * is the trial end. A helper rather than an inline `Date.now()`: the page is
 * rendered on the server, so the countdown is fixed at render time and the text
 * must come from one place that React's purity rule accepts.
 */
function daysUntil(periodEnd: Date | null): number | null {
  if (!periodEnd) return null;
  return Math.max(0, Math.ceil((periodEnd.getTime() - Date.now()) / 86_400_000));
}

function Pill({ tone, children }: { tone: "blue" | "green" | "gray"; children: React.ReactNode }) {
  const cls =
    tone === "blue" ? "bg-blue-100 text-blue-700" : tone === "green" ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-600";
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>{children}</span>;
}

/**
 * The plan the workspace is on, in one honest line. Free workspaces get an
 * upgrade path; paid ones get their renewal date and a way into the portal. The
 * "Trial started" note is a transient flag off the checkout redirect, so it only
 * shows on the first load after a purchase — the persisted status is what stays
 * up after a refresh.
 */
function PlanBanner({ billing, subscription }: { billing?: string; subscription: SubscriptionState }) {
  const paid = subscription ? ["trialing", "active", "past_due"].includes(subscription.status) : false;
  const trialing = subscription?.status === "trialing";
  const justBack = billing === "success" || billing === "portal";
  const renews = subscription?.stripeCurrentPeriodEnd
    ? new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(subscription.stripeCurrentPeriodEnd)
    : null;
  const daysLeft = daysUntil(trialing ? subscription?.stripeCurrentPeriodEnd ?? null : null);
  const daysLeftText = daysLeft === null ? null : `${daysLeft} ${daysLeft === 1 ? "day" : "days"} left`;

  if (justBack && paid) {
    return (
      <div className="rounded-2xl border border-green-200 bg-green-50 p-4 text-sm text-green-800">
        {trialing ? (
          <>
            Trial started — welcome aboard. Your trial runs until {renews ?? "day 14"}
            {daysLeftText ? <> ({daysLeftText})</> : null}, then the first invoice lands. Cancel any time before then and you are not charged.
          </>
        ) : (
          <>Payment received — welcome aboard. Your plan is <strong>{subscription!.status}</strong>.</>
        )}
      </div>
    );
  }

  if (paid) {
    return (
      <div className="flex items-center justify-between gap-4 rounded-2xl border border-gray-200 bg-white p-4 text-sm">
        <span className="flex items-center gap-2">
          <Pill tone={trialing ? "blue" : "green"}>{subscription!.status}</Pill>
          <span className="text-gray-700">
            {trialing
              ? <>Trial active{daysLeftText ? <> — {daysLeftText}</> : null}{renews ? <>, first charge {renews}</> : null}.</>
              : <>Pro plan active{renews ? <>, renews {renews}</> : null}.</>}
          </span>
        </span>
        <ManageBillingButton />
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between gap-4 rounded-2xl border border-gray-200 bg-white p-4 text-sm">
      <span className="flex items-center gap-2">
        <Pill tone="gray">free</Pill>
        <span className="text-gray-700">You are on the free plan. Full product for 14 days on your first paid plan — no charge before day 14, cancel any time from the portal.</span>
      </span>
      <Link href="/pricing" className="shrink-0 rounded-lg bg-blue-600 px-4 py-1.5 text-xs font-semibold text-white hover:bg-blue-700 transition">
        Start free trial
      </Link>
    </div>
  );
}

export default async function DashboardPage({ searchParams }: { searchParams: Promise<{ workspace?: string; billing?: string }> }) {
  const { workspace: requestedSlug, billing } = await searchParams;
  // One policy, shared: the demo stays public, a customer's own workspace needs
  // their session, and naming anyone else's slug is refused rather than served.
  const resolved = await resolveWorkspace(requestedSlug);
  if (!resolved.workspace) {
    return (
      <main className="min-h-screen flex items-center justify-center p-8">
        <div className="max-w-sm text-center">
          <p className="text-gray-600">
            That workspace needs an account. Sign in to open yours.
          </p>
          <a
            href="/login"
            className="mt-4 inline-block rounded-lg bg-gray-900 px-5 py-2.5 text-sm font-semibold text-white hover:bg-gray-700"
          >
            Sign in
          </a>
        </div>
      </main>
    );
  }
  const workspace = resolved.workspace;
  const session = resolved.session;

  const metricOptions = session ? await prisma.metric.findMany({
    where: { workspaceId: workspace.id, status: "ACTIVE" },
    orderBy: { updatedAt: "desc" },
    take: 25,
    select: { id: true, name: true, kind: true, _count: { select: { snapshots: true } } },
  }) : [];

  // The bar's workspace switcher needs the full list. Anonymous visitors get
  // none — the demo badge already says what they are looking at.
  const myWorkspaces = session
    ? await prisma.membership.findMany({
        where: { userId: session.userId },
        include: { workspace: { select: { id: true, name: true, slug: true } } },
        orderBy: { createdAt: "asc" },
      })
    : [];

  const liveKeyCount = session
    ? await prisma.apiKey.count({ where: { workspaceId: workspace.id, revokedAt: null } })
    : null;

  // Read the plan straight from the local row, never through getStripe() — a
  // deployment without STRIPE_SECRET_KEY must still render the dashboard.
  const subscription = session
    ? await prisma.subscription.findUnique({
        where: { workspaceId: workspace.id },
        select: { status: true, stripeCustomerId: true, stripeCurrentPeriodEnd: true },
      })
    : null;

  const [metrics, eventCount, snapshotCount, dashboards, alertRules, reports] = await Promise.all([
    prisma.metric.findMany({
      where: { workspaceId: workspace.id, status: "ACTIVE" },
      include: { snapshots: { orderBy: { createdAt: "desc" }, take: 1 } },
      orderBy: { updatedAt: "desc" },
    }),
    prisma.event.count({ where: { workspaceId: workspace.id } }),
    prisma.snapshot.count({ where: { workspaceId: workspace.id } }),
    prisma.dashboard.findMany({ where: { workspaceId: workspace.id }, orderBy: { updatedAt: "desc" }, take: 10 }),
    session
      ? prisma.alertRule.findMany({
          where: { workspaceId: workspace.id },
          include: { events: { orderBy: { createdAt: "desc" }, take: 5 } },
          orderBy: { updatedAt: "desc" },
        })
      : [],
    session
      ? prisma.reportSchedule.findMany({
          where: { workspaceId: workspace.id },
          include: { metric: { select: { name: true, kind: true } } },
          orderBy: { createdAt: "asc" },
        })
      : [],
  ]);

  return (
    <DashboardShell
      product="AbetAnalytics"
      accent="text-violet-600"
      accentSoft="bg-violet-500"
      account={
        session
          ? {
              name: session.name,
              email: session.email,
              signOut,
              workspaces: myWorkspaces.map((m) => m.workspace),
              currentWorkspaceId: session.workspaceId,
              switchWorkspace: switchWorkspaceAction,
            }
          : null
      }
      workspace={workspace.name}
      title="Revenue dashboard"
    >
        {session && (
          <div className="mb-6">
            <PlanBanner billing={billing} subscription={subscription} />
          </div>
        )}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
          <Card label="Events" value={eventCount.toLocaleString()} />
          <Card label="Metrics" value={metrics.length} />
          <Card label="Snapshots" value={snapshotCount} sub="frozen, with definitions" />
          <Card label="Dashboards" value={dashboards.length} />
        </div>

        <div className="bg-white rounded-2xl shadow-sm p-6 mb-6">
          <h2 className="text-lg font-bold text-gray-900 mb-4">Metrics, latest snapshot each</h2>
          {metrics.length === 0 ? (
            <p className="text-sm text-gray-500">No metrics yet. Create one via <code>POST /api/metrics</code>.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-gray-500">
                    <th className="pb-2 pr-4 font-medium">Metric</th>
                    <th className="pb-2 pr-4 font-medium">Kind</th>
                    <th className="pb-2 pr-4 font-medium">Latest</th>
                    <th className="pb-2 font-medium">Taken</th>
                    <th className="pb-2 font-medium text-right">{session ? "Action" : null}</th>
                  </tr>
                </thead>
                <tbody>
                  {metrics.map((m) => {
                    const latest = m.snapshots[0];
                    const result = latest ? (latest.result as unknown as MetricResult) : null;
                    return (
                      <tr key={m.id} className="border-t border-gray-100">
                        <td className="py-3 pr-4 font-medium text-gray-900">{m.name}</td>
                        <td className="py-3 pr-4 text-gray-600">{m.kind}</td>
                        <td className="py-3 pr-4 text-gray-900 font-semibold">
                          {result ? formatMetricHeadline(result) : "—"}
                        </td>
                        <td className="py-3 text-gray-600">
                          {latest ? new Date(latest.createdAt).toLocaleDateString() : "never"}
                        </td>
                        <td className="py-3 text-right">
                          {session && latest && (
                            <div className="flex flex-col items-end gap-2">
                              <BreakdownButton
                                metricId={m.id}
                                name={m.name}
                                kind={m.kind}
                                rangeStart={new Date(latest.rangeStart).toISOString()}
                                rangeEnd={new Date(latest.rangeEnd).toISOString()}
                              />
                              <ShareSnapshot
                                snapshotId={latest.id}
                                initialUrl={
                                  latest.shareToken && !latest.shareRevokedAt
                                    ? shareUrl(latest.shareToken)
                                    : null
                                }
                              />
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {session && (
          <div className="mb-6 bg-white rounded-2xl shadow-sm p-6">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-lg font-bold text-gray-900">Weekly report</h2>
              <p className="text-xs text-gray-500">The frozen number, on its own</p>
            </div>
            <p className="mt-1 mb-4 max-w-3xl text-sm text-gray-600">
              A number that has to be fetched is a number that gets forgotten. Schedule the weekly
              report and the same metric — over the same window, frozen with its definition — is
              emailed to you, with a read-only link that anyone can open without an account.
            </p>
            <ReportScheduler
              metrics={metrics.map((m) => ({ id: m.id, name: m.name }))}
              reports={reports.map((r) => {
                // Dates do not cross the server/client boundary; the client
                // formats them in the schedule's own timezone anyway.
                const preview = reportPreview(r);
                return {
                  id: preview.id,
                  metricId: preview.metricId,
                  metricName: preview.metricName,
                  email: preview.email,
                  dayOfWeek: preview.dayOfWeek,
                  hour: preview.hour,
                  timezone: preview.timezone,
                  windowDays: preview.windowDays,
                  lastSentAt: preview.lastSentAt ? preview.lastSentAt.toISOString() : null,
                  lastError: preview.lastError,
                  nextRunAt: preview.nextRunAt,
                };
              })}
            />
          </div>
        )}

        {session && canManageRoles(session.role) && (
          <div className="mb-6 rounded-2xl bg-white p-6 shadow-sm">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-lg font-bold text-gray-900">Export</h2>
              <p className="text-xs text-gray-500">Owners and admins</p>
            </div>
            <p className="mt-1 max-w-3xl text-sm text-gray-600">
              The board pack is every frozen snapshot — funnels included — with the definition and
              result that produced it, one row each. The workspace export carries metrics,
              snapshots, dashboards, alerts and team as JSON. Raw events stream separately so a
              large workspace never has to fit in memory.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <a
                href="/api/export/snapshots"
                className="rounded-lg bg-violet-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-violet-700"
              >
                Download board pack (CSV)
              </a>
              <a
                href="/api/export"
                className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-semibold text-gray-700 transition hover:bg-gray-50"
              >
                Download workspace (JSON)
              </a>
              <a
                href="/api/export/events"
                className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-semibold text-gray-700 transition hover:bg-gray-50"
              >
                Download raw events (CSV)
              </a>
            </div>
            <p className="mt-3 text-xs text-gray-500">
              Signing secrets, API keys and invitation tokens are never included.
            </p>
          </div>
        )}

        <div className="bg-white rounded-2xl shadow-sm p-6">
          <h2 className="text-lg font-bold text-gray-900 mb-4">Dashboards</h2>
          {dashboards.length === 0 ? (
            <p className="text-sm text-gray-500">No dashboards yet.</p>
          ) : (
            <ul className="space-y-2">
              {dashboards.map((d) => (
                <li key={d.id} className="text-sm text-gray-900">
                  <span className="font-medium">{d.name}</span>
                  {d.description && <span className="text-gray-500"> — {d.description}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>

        {session && alertRules.length > 0 && (
          <div className="mt-6 bg-white rounded-2xl shadow-sm p-6">
            <h2 className="text-lg font-bold text-gray-900 mb-4">Alert rules</h2>
            <div className="space-y-3">
              {alertRules.map((r) => (
                <div key={r.id} className="flex items-center justify-between gap-4 rounded-xl border border-gray-200 bg-white p-4 text-sm">
                  <div className="flex items-center gap-3">
                    <Pill tone={r.isActive ? "green" : "gray"}>{r.isActive ? "active" : "silent"}</Pill>
                    <div>
                      <span className="font-medium text-gray-900">{r.name}</span>
                      <span className="ml-2 text-xs text-gray-500">{r.operator} {r.threshold}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-gray-500">
                    {r.events.length > 0 ? (
                      <>
                        Last fired:{" "}
                        <span className="font-medium text-gray-900">
                          {new Date(r.events[0].createdAt).toLocaleString()}
                        </span>
                        ({r.events.length} event{r.events.length === 1 ? "" : "s"})
                      </>
                    ) : (
                      <span>never fired</span>
                    )}
                    <span className="text-gray-400">{r.secret.slice(0, 8)}…</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {session && (
          <div className="mt-6">
          <AiPanel
            config={{
              title: "Explain a metric move",
              blurb:
                "Compares the last two snapshots and explains what changed, using only the dimension breakdown the metrics engine computed. Speculation is kept separate from what the data shows.",
              endpoint: "/api/ai/explain-metric",
              entityLabel: "Metric",
              idField: "metricId",
              buttonLabel: "Explain this change",
              emptyText: "No metrics yet, or none with two snapshots to compare.",
              options: metricOptions.map((m) => ({
                id: m.id,
                label: `${m.name} (${m.kind}) — ${m._count.snapshots} snapshot${m._count.snapshots === 1 ? "" : "s"}`,
              })),
            }}
            fields={[
              { path: "current", title: "Current value" },
              { path: "previous", title: "Previous value" },
              { path: "changePct", title: "Change" },
              { path: "explanation.summary", title: "What moved" },
              { path: "explanation.contributors", title: "Contributors", list: true },
              { path: "explanation.hypotheses", title: "Worth ruling out", list: true },
              { path: "explanation.recommendation", title: "Suggested next step" },
            ] satisfies AiField[]}
          />
        </div>
      )}

      {session && liveKeyCount === 0 && (
        // Only for a signed-in workspace with no usable key: a stranger on the
        // public demo has no account to attach a key to, and prompting them
        // would be an invitation to sign up mid-demo.
        <div className="mt-6">
          <ApiKeyOnboarding createKey={createFirstKey} />
        </div>
      )}
      </DashboardShell>
  );
}
