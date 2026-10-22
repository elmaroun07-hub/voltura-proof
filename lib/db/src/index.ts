import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

/**
 * DATABASE_URL is checked here, on first use, rather than in the module body.
 *
 * The module-load throw blocked type-only imports: every consumer of this
 * package takes schema, types and constants only (`calculations`,
 * `calculationInputSchema`, `MonthlyEntry`, …), so importing a Zod schema to
 * validate a request body required a provisioned database. That made
 * `pnpm -r test` unrunnable without one — api-server's suites died at
 * collection, which read as a passing build because nothing ever executed.
 *
 * Boot-time fail-fast is unaffected. It comes from
 * artifacts/api-server/src/db.ts, which carries its own identical guard and
 * sits on the server's startup path (index.ts → ensure-chat-tables.ts → ./db),
 * so a genuinely missing DATABASE_URL still kills the process before it
 * listens. Do not remove that guard on the assumption this one covers it.
 */
function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL must be set. Did you forget to provision a database?",
    );
  }
  return url;
}

function createPool(): InstanceType<typeof Pool> {
  return new Pool({ connectionString: requireDatabaseUrl() });
}

function createDb() {
  return drizzle(getPool(), { schema });
}

let cachedPool: ReturnType<typeof createPool> | undefined;
let cachedDb: ReturnType<typeof createDb> | undefined;

/** Lazily constructed connection pool. Throws if DATABASE_URL is unset. */
export function getPool(): ReturnType<typeof createPool> {
  cachedPool ??= createPool();
  return cachedPool;
}

/** Lazily constructed Drizzle client. Throws if DATABASE_URL is unset. */
export function getDb(): ReturnType<typeof createDb> {
  cachedDb ??= createDb();
  return cachedDb;
}

export * from "./schema";
