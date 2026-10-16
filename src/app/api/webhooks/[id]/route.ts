import { NextResponse } from "next/server";
import { withAuth, assertOwns } from "@/lib/apikeys";
import { prisma } from "@/lib/db";
import { classifyTarget } from "@/lib/egress";
import { readJson, validateBody, eventNames, NO_FIELD_TO_UPDATE } from "@/lib/validate";
import { WEBHOOK_PATCH } from "@/lib/fields";
import { unknownEventsProblem, webhookPreview } from "@/lib/webhooks";

export const dynamic = "force-dynamic";

async function GET_impl(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const webhook = await prisma.webhook.findUnique({ where: { id } });
  if (!webhook) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await assertOwns(request, webhook.workspaceId);
  return NextResponse.json(webhookPreview(webhook));
}

async function PATCH_impl(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const read = await readJson(request);
  if (read.error) return read.error;
  const { body } = read;

  const owned = await prisma.webhook.findUnique({ where: { id }, select: { workspaceId: true } });
  if (!owned) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await assertOwns(request, owned.workspaceId);

  // `requireWrite` is deliberately not passed: a body holding only `events` is
  // a real write that the field table cannot see, and the flag would refuse it
  // as empty. The emptiness check runs below, on the merged object instead.
  const checked = validateBody(body, WEBHOOK_PATCH);
  if (checked.error) return checked.error;

  const events = body.events === undefined ? undefined : eventNames(body.events);
  if (events && events.error) return events.error;
  // Same rule as POST: a name this product never emits is refused, not stored.
  if (events?.ok) {
    const unknown = unknownEventsProblem(events.values);
    if (unknown) return NextResponse.json({ error: unknown }, { status: 400 });
  }

  if (checked.data.url !== undefined) {
    const target = await classifyTarget(checked.data.url, "url");
    if (!target.ok) return NextResponse.json({ error: target.reason }, { status: 422 });
  }

  const data = { ...checked.data, ...(events?.ok ? { events: events.values.join(",") } : {}) };
  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: NO_FIELD_TO_UPDATE }, { status: 400 });
  }

  const webhook = await prisma.webhook.update({ where: { id }, data });
  return NextResponse.json(webhookPreview(webhook));
}

async function DELETE_impl(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const owned = await prisma.webhook.findUnique({ where: { id }, select: { workspaceId: true } });
  if (!owned) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await assertOwns(request, owned.workspaceId);
  await prisma.webhook.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}

export const GET = withAuth(GET_impl);
export const PATCH = withAuth(PATCH_impl);
export const DELETE = withAuth(DELETE_impl);
