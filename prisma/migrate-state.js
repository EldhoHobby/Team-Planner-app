// Used by migrate.sh: prints the database's migration state so the one-shot
// migrate service knows whether to baseline before `prisma migrate deploy`.
//   "migrated" — has a _prisma_migrations history table (normal case)
//   "baseline" — has app tables (built by the old `db push` flow) but no history
//   "fresh"    — empty database (deploy will create everything from 0_init)
const { PrismaClient } = require("@prisma/client");

(async () => {
  const prisma = new PrismaClient();
  try {
    const [r] = await prisma.$queryRawUnsafe(
      `SELECT (to_regclass('public._prisma_migrations') IS NOT NULL) AS hist,
              (to_regclass('public."User"') IS NOT NULL) AS users`,
    );
    console.log(r.hist ? "migrated" : r.users ? "baseline" : "fresh");
  } finally {
    await prisma.$disconnect();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
