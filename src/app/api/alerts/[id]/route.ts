import { NextResponse } from "next/server";
import { withAuth, assertOwns } from "@/lib/apikeys";
import { prisma } from "@/lib/db";
import { classifyTarget } from "@/lib/egress";
import { readJson, validateBody } from "@/lib/validate";
import { ALERT_UPDATE } from "@/lib/fields";
import { alertRulePreview } from "@/lib/alerts";
import crypto from "crypto";

export const dynamic = "force-dynamic";

async function GET_impl(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { searchParams } = new URL(request.url);

  // Settled before any branch. The ?events path read alertEvent by ruleId and
  // returned it without ever asking whose rule it was, so the ownership check
  // further down only guarded the other half of this handler.
  const owned = await prisma.alertRule.findUnique({ where: { id }, select: { workspaceId: true } });
  if (!owned) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await assertOwns(request, owned.workspaceId);

  if (searchParams.get("events") === "true") {
    const events = await prisma.alertEvent.findMany({
      where: { ruleId: id },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    return NextResponse.json({ events });
  }

  const rule = await prisma.alertRule.findUnique({
    where: { id },
    include: { events: { orderBy: { createdAt: "desc" }, take: 10 } },
  });
  if (!rule) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(alertRulePreview(rule));
}

async function PATCH_impl(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const read = await readJson(request);
  if (read.error) return read.error;
  const { body } = read;

  const _owned = await prisma.alertRule.findUnique({ where: { id }, select: { workspaceId: true } });
  if (!_owned) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await assertOwns(request, _owned.workspaceId);

  const checked = validateBody(body, ALERT_UPDATE, { requireWrite: true });
  if (checked.error) return checked.error;
  const { name, operator, threshold, webhookUrl, isActive, rotateSecret } = checked.data;

  if (webhookUrl !== undefined) {
    const target = await classifyTarget(webhookUrl, "webhookUrl");
    if (!target.ok) return NextResponse.json({ error: target.reason }, { status: 422 });
  }

  // Rotation is the one PATCH that hands a secret back — the new one, once.
  // Every other PATCH answers with the preview, like every read.
  const newSecret = rotateSecret === true ? crypto.randomBytes(32).toString("hex") : undefined;
  const rule = await prisma.alertRule.update({
    where: { id },
    data: {
      ...(name !== undefined ? { name } : {}),
      ...(operator !== undefined ? { operator } : {}),
      ...(threshold !== undefined ? { threshold } : {}),
      ...(webhookUrl !== undefined ? { webhookUrl } : {}),
      ...(isActive !== undefined ? { isActive } : {}),
      ...(newSecret ? { secret: newSecret } : {}),
    },
  });
  return NextResponse.json(newSecret ? rule : alertRulePreview(rule));
}

async function DELETE_impl(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const _owned = await prisma.alertRule.findUnique({ where: { id }, select: { workspaceId: true } });
  if (!_owned) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await assertOwns(request, _owned.workspaceId);
  await prisma.alertRule.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}

export const GET = withAuth(GET_impl);
export const PATCH = withAuth(PATCH_impl);
export const DELETE = withAuth(DELETE_impl);
