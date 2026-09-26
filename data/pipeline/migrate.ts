/** Applies db/migrations/*.sql in order, once each. `pnpm db:migrate` */
import { readdirSync, readFileSync } from "node:fs";
import { connect } from "./db.js";
import { REPO_ROOT } from "./lib.js";

const dir = new URL("db/migrations/", REPO_ROOT);
const sql = connect();
try {
  await sql`create table if not exists schema_migrations (version text primary key, applied_at timestamptz not null default now())`;
  const applied = new Set((await sql<{ version: string }[]>`select version from schema_migrations`).map((r) => r.version));
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    const t0 = performance.now();
    await sql.begin(async (tx) => {
      await tx.unsafe(readFileSync(new URL(file, dir), "utf8"));
      await tx`insert into schema_migrations (version) values (${file})`;
    });
    console.log(`applied ${file} (${(performance.now() - t0).toFixed(0)} ms)`);
  }
  console.log(`schema up to date (${files.length} migrations)`);
} finally {
  await sql.end();
}
