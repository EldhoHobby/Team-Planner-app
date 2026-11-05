// Used by migrate.sh: makes sure the read-only Excel login exists before
// reporting.sql grants it access to the reporting views.
//   EXCEL_DB_PASSWORD set   → excel_reader can log in, with that password
//   EXCEL_DB_PASSWORD blank → excel_reader exists but CANNOT log in (feature off)
// The role is read-only by default and can only see the "reporting" schema
// (granted in reporting.sql); it never gets rights on the raw tables.
const { PrismaClient } = require("@prisma/client");

const ROLE = "excel_reader";

(async () => {
  const prisma = new PrismaClient();
  try {
    const [{ exists }] = await prisma.$queryRawUnsafe(
      `SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${ROLE}') AS exists`,
    );
    if (!exists) await prisma.$executeRawUnsafe(`CREATE ROLE ${ROLE} NOLOGIN`);

    const password = (process.env.EXCEL_DB_PASSWORD ?? "").trim();
    if (password) {
      // Let Postgres quote the password (%L) so no character can break out.
      // (Role name is literal here: ${} in a tagged template becomes a bind
      // parameter, which is not allowed inside the format string.)
      const [{ sql }] = await prisma.$queryRaw`
        SELECT format('ALTER ROLE excel_reader WITH LOGIN PASSWORD %L', ${password}::text) AS sql`;
      await prisma.$executeRawUnsafe(sql);
    } else {
      await prisma.$executeRawUnsafe(`ALTER ROLE ${ROLE} WITH NOLOGIN PASSWORD NULL`);
    }
    await prisma.$executeRawUnsafe(
      `ALTER ROLE ${ROLE} WITH NOSUPERUSER NOCREATEDB NOCREATEROLE CONNECTION LIMIT 20`,
    );
    await prisma.$executeRawUnsafe(`ALTER ROLE ${ROLE} SET default_transaction_read_only = on`);
    await prisma.$executeRawUnsafe(`ALTER ROLE ${ROLE} SET statement_timeout = '60s'`);
    console.log(password ? `${ROLE}: login enabled` : `${ROLE}: login disabled (EXCEL_DB_PASSWORD not set)`);
  } finally {
    await prisma.$disconnect();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
