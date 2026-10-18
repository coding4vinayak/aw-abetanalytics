"use client";

import { useState, useTransition } from "react";
import { revokeSnapshotShareAction, shareSnapshotAction } from "@/app/share-actions";

/**
 * "Share" for one frozen snapshot: mint a read-only link, copy it, kill it.
 *
 * The URL the server hands back is the source of truth for the display — the
 * action is deliberately idempotent while a link is live, so a second click
 * returns the same link rather than rotating the one already sent.
 */
export function ShareSnapshot({
  snapshotId,
  initialUrl,
}: {
  snapshotId: string;
  initialUrl: string | null;
}) {
  const [url, setUrl] = useState(initialUrl);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [pending, startTransition] = useTransition();

  function share() {
    setError(null);
    startTransition(async () => {
      const res = await shareSnapshotAction(snapshotId);
      if (res.ok) setUrl(res.url);
      else setError(res.error);
    });
  }

  function revoke() {
    setError(null);
    startTransition(async () => {
      const res = await revokeSnapshotShareAction(snapshotId);
      if (res.ok) {
        setUrl(null);
        setCopied(false);
      } else {
        setError(res.error);
      }
    });
  }

  async function copy() {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      // Clipboard access can be denied (permissions, non-secure origin). The
      // field is selectable, so the honest move is to say so, not to claim a copy.
      setError("Copy failed — select the link and copy it.");
    }
  }

  if (!url) {
    return (
      <button
        type="button"
        onClick={share}
        disabled={pending}
        className="text-xs font-medium text-blue-600 hover:text-blue-700 disabled:opacity-50"
      >
        {pending ? "Sharing…" : "Share"}
      </button>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        <input
          readOnly
          value={url}
          onFocus={(e) => e.currentTarget.select()}
          className="w-56 rounded-md border border-gray-200 bg-gray-50 px-2 py-1 text-xs text-gray-700"
          aria-label="Read-only share link"
        />
        <button
          type="button"
          onClick={copy}
          className="text-xs font-medium text-blue-600 hover:text-blue-700"
        >
          {copied ? "Copied" : "Copy"}
        </button>
        <button
          type="button"
          onClick={revoke}
          disabled={pending}
          className="text-xs font-medium text-gray-500 hover:text-red-600 disabled:opacity-50"
        >
          Stop
        </button>
      </div>
      {error && <span className="text-xs text-red-600">{error}</span>}
    </div>
  );
}
