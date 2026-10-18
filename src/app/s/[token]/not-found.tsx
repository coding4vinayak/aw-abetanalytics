import Link from "next/link";

/**
 * Shown when a share token resolves to nothing — revoked, rotated, or never
 * issued. The copy deliberately does not say which: a reader of a dead link is
 * told to ask the sender, and a scanner learns nothing either way.
 */
export default function ShareNotFound() {
  return (
    <main className="mx-auto flex max-w-lg flex-col items-center px-6 py-24 text-center">
      <span className="text-sm font-semibold tracking-tight text-gray-900">
        Abet<span className="text-blue-600">Analytics</span>
      </span>
      <h1 className="mt-6 text-2xl font-bold text-gray-900">This shared link isn’t available</h1>
      <p className="mt-2 text-sm text-gray-500">
        It may have been revoked, or the number was never shared here. Ask whoever sent it for a
        fresh link.
      </p>
      <Link href="/" className="mt-6 text-sm font-medium text-blue-600 hover:text-blue-700">
        Go to AbetAnalytics
      </Link>
    </main>
  );
}
