import type { Metadata } from "next";
import { SiteNav, SiteFooter } from "@/components/site";

export const metadata: Metadata = {
  title: "Changelog — AbetAnalytics",
  description: "What changed in AbetAnalytics, newest first.",
};

export default function Page() {
  return (
    <div className="min-h-screen bg-white text-gray-900">
      <SiteNav />
      <main className="mx-auto max-w-4xl px-6 py-12">
        <h1 className="text-3xl font-bold tracking-tight">Changelog</h1>
        <p className="mt-2 text-gray-600">Newest first. Breaking changes are marked <strong>BREAKING</strong> and get 30 days&apos; notice here before they ship.</p>
        <div className="mt-8 space-y-8 border-l-2 border-blue-600 pl-6">
          <div>
            <p className="text-sm text-gray-600">October 2026</p>
            <h2 className="text-lg font-bold">v1.4.0 — See it work, then let it work for you</h2>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-gray-600">
              <li>A new workspace can load a week of example revenue in one click — two metrics, 223 events and a frozen number — so the product can be seen before any real data is connected. It is labelled as example data, and one click removes it again.</li>
              <li>A weekly report emails that frozen number with its definition and a read-only link, on the day and hour you set, in your own timezone. A report never re-fires the alert rules: the customer may already have been paged for that number.</li>
              <li>The emailed link is the same revocable link the dashboard hands out, so the report can be forwarded to whoever has to see the number.</li>
            </ul>
          </div>
          <div>
            <p className="text-sm text-gray-600">October 2026</p>
            <h2 className="text-lg font-bold">v1.3.0 — Share the number, and see why it moved</h2>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-gray-600">
              <li>Any frozen number can be shared as a read-only link — a capability token, revocable — that anyone opens with no account, showing the value, the range and the definition it was computed from. The page is noindex, and the link can be revoked at any time.</li>
              <li>&quot;Why did the number move?&quot; — a dimension breakdown splits the movement between two ranges, and every segment is computed by the same engine that produced the headline, so the parts cannot drift from the whole.</li>
            </ul>
          </div>
          <div>
            <p className="text-sm text-gray-600">October 2026</p>
            <h2 className="text-lg font-bold">v1.1.0 — Take your numbers with you</h2>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-gray-600">
              <li>Owners and admins can download a board-pack CSV of every frozen snapshot and funnel, a workspace JSON with metrics, snapshots, dashboards, alerts and team, and a streamed CSV of raw events.</li>
              <li>Exports are session-authenticated and owner/admin only. They leave credentials behind: no API keys, invitation tokens, signing secrets or Stripe ids.</li>
            </ul>
          </div>
          <div>
            <p className="text-sm text-gray-600">September 2026</p>
            <h2 className="text-lg font-bold">v1.0.0 — Initial public release</h2>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-gray-600">
              <li>General availability: Define a metric once, snapshot it with its definition attached. Renaming the metric next week cannot rewrite what the board agreed this week.</li>
              <li>Public pricing, terms, privacy, and support pages.</li>
              <li>Live demo workspace, no card required.</li>
            </ul>
          </div>
        </div>
        <p className="mt-8 text-gray-600">How we version: <code>major.minor.patch</code>. Minor adds features, patch fixes bugs, major is reserved for contract changes — and those are announced here first.</p>
      </main>
      <SiteFooter />
    </div>
  );
}
