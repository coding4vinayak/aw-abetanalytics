// The buyer of simulation #2: a real user row, a real workspace, an OWNER
// membership — exactly the shape signup creates — so the billing mails have a
// real address to resolve. Copied into the app as prisma/.sim-seed.mts and run
// with the app's own tsx + prisma + password hasher, the same way prisma/seed.ts
// runs. Prints SIM_WORKSPACE_ID for the webhook driver.
//
// The db module is imported as a namespace because the fleet is not uniform:
// most apps export `prisma`, aw-abetConnect exports `db`. Same client inside.
import * as dbLib from "../src/lib/db";
import { hashPassword } from "../src/lib/password";

const prisma = (dbLib as { prisma?: unknown; db?: unknown }).prisma ??
  (dbLib as { prisma?: unknown; db?: unknown }).db;
if (!prisma) throw new Error("sim-seed: neither `prisma` nor `db` is exported by src/lib/db");

async function main() {
  const email = "sim-buyer@sim.abetworks.test";
  const user = await prisma.user.upsert({
    where: { email },
    update: { emailVerified: true },
    create: {
      email,
      name: "Sim Buyer",
      passwordHash: await hashPassword("sim-password-123"),
      emailVerified: true,
    },
  });
  const workspace = await prisma.workspace.upsert({
    where: { slug: "sim-buyer" },
    update: {},
    create: { name: "Sim Buyer Studio", slug: "sim-buyer" },
  });
  await prisma.membership.upsert({
    where: { userId_workspaceId: { userId: user.id, workspaceId: workspace.id } },
    update: { role: "OWNER" },
    create: { userId: user.id, workspaceId: workspace.id, role: "OWNER" },
  });
  console.log(`SIM_WORKSPACE_ID=${workspace.id}`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
