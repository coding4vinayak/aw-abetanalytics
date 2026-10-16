import { NextResponse } from "next/server";
import { withAuth, authedWorkspaceId } from "@/lib/apikeys";
import { prisma } from "@/lib/db";
import { classifyTarget } from "@/lib/egress";
import { readJson, validateBody, eventNames } from "@/lib/validate";
import { WEBHOOK_CREATE } from "@/lib/fields";
import { unknownEventsProblem, webhookPreview } from "@/lib/webhooks";
import crypto from "crypto";

export const dynamic = "force-dynamic";

async function GET_impl(request: Request) {
  const { searchParams } = new URL(request.url);
  const workspaceId = await authedWorkspaceId(request, searchParams.get("workspaceId"));

  const webhooks = await prisma.webhook.findMany({ where: { workspaceId }, orderBy: { createdAt: "desc" } });
  // The signing secret is returned by POST, once; readers get the prefix.
  return NextResponse.json({ webhooks: webhooks.map(webhookPreview) });
}

async function POST_impl(request: Request) {
  const read = await readJson(request);
  if (read.error) return read.error;
  const { body } = read;

  const workspaceId = await authedWorkspaceId(request, body.workspaceId);

  const checked = validateBody(body, WEBHOOK_CREATE);
  if (checked.error) return checked.error;
  const { url } = checked.data;

  // The README shows an array of event names; the column is a String and the
  // reader splits it on commas. Both shapes are accepted, one is stored.
  const events = eventNames(body.events);
  if (events.error) return events.error;

  // A name this product never emits is a subscription that never fires — the
  // same silence as no subscription at all, arrived at from the other side.
  // The typo is refused here instead of stored.
  const unknown = unknownEventsProblem(events.values);
  if (unknown) return NextResponse.json({ error: unknown }, { status: 400 });

  // The destination is refused here (rule: no internal address) and again at
  // delivery time (the address DNS now points at) — the same two checks
  // `alerts.ts` runs for a rule's webhookUrl, and the same status its route
  // answers with.
  const target = await classifyTarget(url, "url");
  if (!target.ok) return NextResponse.json({ error: target.reason }, { status: 422 });

  const secret = crypto.randomBytes(32).toString("hex");
  const webhook = await prisma.webhook.create({
    data: { workspaceId, url, events: events.values.join(","), secret },
  });
  return NextResponse.json(webhook, { status: 201 });
}

export const GET = withAuth(GET_impl);
export const POST = withAuth(POST_impl);
