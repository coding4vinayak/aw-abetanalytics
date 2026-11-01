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
            <p className="text-sm text-muted">November 2026</p>
            <h2 className="text-lg font-bold">v1.7.1 — Deliveries a receiver can age out and dedupe</h2>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-muted">
              <li>Outbound deliveries now carry <code>X-Webhook-Timestamp</code> and <code>X-Webhook-Delivery</code> beside the signature headers. A receiver on the nuCRM side — whose plugin endpoint enforces a 5-minute freshness window only when the timestamp header is present, and skips the check when it is not — now refuses a stale re-send instead of accepting it a second time.</li>
              <li><code>X-Webhook-Delivery</code> is the payload <code>id</code>, which lives inside the signed body: a receiver that remembers delivery ids rejects a duplicate arrival, and a replayer cannot hand it a new one without breaking the signature. The bytes signed and the headers already verified are unchanged.</li>
              <li>Alert deliveries carry both headers too, and the <code>AlertEvent</code> row written before the POST is now the body&rsquo;s <code>id</code> — one id for the firing, the receipt and the dedupe key, with the signature covering it.</li>
            </ul>
          </div>
          <div>
            <p className="text-sm text-muted">October 2026</p>
            <h2 className="text-lg font-bold">v1.7.0 — The deep-content file</h2>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-muted">
              <li><code>/llms-full.txt</code> serves the whole substance in one fetch for AI assistants: the shipped index carried verbatim, then every one of the contract&rsquo;s 41 operations with its own summary and the door it declares. Built from the index and the contract themselves, not from hand-written prose, so it cannot say more than the product does.</li>
              <li>A test holds the generated file against the live sources — after the index or the contract changes, a stale full file fails the build naming the first line that moved.</li>
            </ul>
          </div>
          <div>
            <p className="text-sm text-muted">October 2026</p>
            <h2 className="text-lg font-bold">v1.6.0 — Also in the Abetworks suite</h2>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-muted">
              <li>The pricing page now says what the suite is: every product is sold standalone, and one contract can set up a workspace across all of them.</li>
              <li>It names the three products teams pair this one with, each linking to its own sign-up and saying what it costs &mdash; so a buyer reading this page is a buyer the team could have had a different conversation with.</li>
            </ul>
          </div>
          <div>
            <p className="text-sm text-muted">October 2026</p>
            <h2 className="text-lg font-bold">v1.5.0 — The contract, and the check that keeps it true</h2>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-muted">
              <li>The API now publishes an OpenAPI 3.1 contract: <code>/openapi.json</code> (the conventional path every tool probes first) and <code>/api/openapi</code> (the versioned alias), unauthenticated, because a contract is a description and an integrator should be able to read it before it has a key.</li>
              <li>The contract cannot drift from the product. A check reads every claim back out of the source that serves it: every documented call has a route that answers it and every route that answers is documented; every request body is compared with the app&rsquo;s own declared field table, so the contract cannot advertise a field the door would refuse nor omit one it requires; the auth a route enforces is the auth the contract advertises; and the version is the app&rsquo;s own version.</li>
              <li>It caught four of its own mistakes while it was being written &mdash; a dashboard that took metric ids the door does not, an alert that claimed an email address the door never reads, a report missing its window, and an explanation carrying four range fields the door does not accept.</li>
            </ul>
          </div>
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
