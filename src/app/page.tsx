import type { Metadata } from "next";
import Link from "next/link";
import { SiteNav, SiteFooter } from "@/components/site";

export const metadata: Metadata = {
  title: "AbetAnalytics — Revenue intelligence your board will not argue with.",
  description: "Define a metric once, snapshot it with its definition attached. Renaming the metric next week cannot rewrite what the board agreed this week.",
};

export default function Home() {
  return (
    <div className="min-h-screen bg-white text-gray-900">
      <SiteNav />
      <main>
        <section className="mx-auto max-w-4xl px-6 pb-16 pt-20 text-center">
          <p className="inline-block rounded-full bg-blue-50 text-blue-700 px-3 py-1 text-xs font-semibold uppercase tracking-wide">
            v1.0 · Now generally available
          </p>
          <h1 className="mt-6 text-5xl font-bold tracking-tight">AbetAnalytics</h1>
          <p className="mx-auto mt-4 max-w-2xl text-xl text-gray-600">Revenue intelligence your board will not argue with.</p>
          <p className="mx-auto mt-3 max-w-2xl text-gray-600">Define a metric once, snapshot it with its definition attached. Renaming the metric next week cannot rewrite what the board agreed this week.</p>
          <div className="mt-8 flex justify-center gap-4">
            <a href="/dashboard?workspace=demo" className="rounded-lg bg-blue-600 px-6 py-3 font-semibold text-white hover:bg-blue-700 transition">
              Open live demo
            </a>
            <Link href="/pricing" className="rounded-lg border border-gray-300 hover:bg-gray-50 px-6 py-3 font-semibold transition">
              Pricing · $19/month · 14-day free trial
            </Link>
          </div>
        </section>
        <section id="features" className="mx-auto max-w-6xl px-6 py-12">
          <h2 className="text-center text-2xl font-bold">Why teams pick AbetAnalytics</h2>
          <div className="mt-8 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          <div className="rounded-2xl border p-6 border-gray-200 bg-white shadow-sm">
            <h3 className="font-bold text-gray-900">Five metric kinds</h3>
            <p className="mt-2 text-sm text-gray-600">Count, sum, avg, unique, and ordered funnels with per-step conversion — filters on any dimension.</p>
          </div>
          <div className="rounded-2xl border p-6 border-gray-200 bg-white shadow-sm">
            <h3 className="font-bold text-gray-900">Snapshots that freeze truth</h3>
            <p className="mt-2 text-sm text-gray-600">Each snapshot carries the definition as-run. The number is forever reproducible.</p>
          </div>
          <div className="rounded-2xl border p-6 border-gray-200 bg-white shadow-sm">
            <h3 className="font-bold text-gray-900">Broken metrics fail at birth</h3>
            <p className="mt-2 text-sm text-gray-600">Definitions validate at creation with a 422 today — not at the first board meeting.</p>
          </div>
          <div className="rounded-2xl border p-6 border-gray-200 bg-white shadow-sm">
            <h3 className="font-bold text-gray-900">Alerts that watch for you</h3>
            <p className="mt-2 text-sm text-gray-600">Thresholds and comparisons notify before the number becomes a surprise.</p>
          </div>
          <div className="rounded-2xl border p-6 border-gray-200 bg-white shadow-sm">
            <h3 className="font-bold text-gray-900">Funnels with receipts</h3>
            <p className="mt-2 text-sm text-gray-600">Step counts and conversion ordered by timestamp, identity-resolved across events.</p>
          </div>
          <div className="rounded-2xl border p-6 border-gray-200 bg-white shadow-sm">
            <h3 className="font-bold text-gray-900">Backfills without fear</h3>
            <p className="mt-2 text-sm text-gray-600">Enqueue large ranges on the snapshots queue; inline compute for everything else.</p>
          </div>
          </div>
        </section>
        <section className="border-y border-gray-200 bg-gray-50">
          <div className="mx-auto max-w-4xl space-y-6 px-6 py-12">
            <h2 className="text-2xl font-bold">Live in three steps</h2>
          <div className="flex gap-4">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-blue-600 text-sm font-bold text-white">1</span>
            <div><p className="font-bold text-gray-900">Send events</p><p className="mt-1 text-sm text-gray-600">The demo workspace has 102 events waiting. Your app posts value plus dimensions the same way.</p></div>
          </div>
          <div className="flex gap-4">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-blue-600 text-sm font-bold text-white">2</span>
            <div><p className="font-bold text-gray-900">Define metrics once</p><p className="mt-1 text-sm text-gray-600">Pick a kind, set filters, validate. The demo ships three working metrics.</p></div>
          </div>
          <div className="flex gap-4">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-blue-600 text-sm font-bold text-white">3</span>
            <div><p className="font-bold text-gray-900">Snapshot the week</p><p className="mt-1 text-sm text-gray-600">Freeze numbers with definitions attached — try the 60 → 30 → 6 funnel.</p></div>
          </div>
          </div>
        </section>
        <section className="mx-auto max-w-4xl px-6 py-12">
          <h2 className="text-2xl font-bold">Questions, answered</h2>
          <div className="mt-6 space-y-4">
          <div><p className="font-semibold text-gray-900">Is there a trial?</p><p className="mt-1 text-gray-600">It is included — open the live demo with 102 events, 3 metrics, and a dashboard. No card, ever.</p></div>
          <div><p className="font-semibold text-gray-900">What if we change a metric later?</p><p className="mt-1 text-gray-600">Snapshots keep the definition as-run, so history never rewrites itself.</p></div>
          <div><p className="font-semibold text-gray-900">How is this different from a dashboard tool?</p><p className="mt-1 text-gray-600">Dashboards show queries; AbetAnalytics freezes answers. The snapshot is the contract.</p></div>
          <div><p className="font-semibold text-gray-900">Can I export the numbers?</p><p className="mt-1 text-gray-600">Yes — owners and admins can download a board-pack CSV with every frozen snapshot and funnel, plus a workspace JSON with the metric definitions and dashboards.</p></div>
          </div>
        </section>
        <section className="mx-auto max-w-4xl px-6 pb-16 text-center">
          <h2 className="text-2xl font-bold">Try the live demo — no card, no call.</h2>
          <div className="mt-6 flex justify-center gap-4">
            <a href="/dashboard?workspace=demo" className="rounded-lg bg-blue-600 px-6 py-3 font-semibold text-white hover:bg-blue-700 transition">
              Open live demo
            </a>
            <Link href="/pricing" className="rounded-lg border border-gray-300 hover:bg-gray-50 px-6 py-3 font-semibold transition">
              See pricing
            </Link>
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
