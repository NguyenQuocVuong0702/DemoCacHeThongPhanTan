import "dotenv/config";

import { readFile } from "node:fs/promises";

import { pool } from "./db.js";

const migrationFiles = [
  "001_initial_schema.sql",
  "002_add_location_fields.sql",
  "003_seed_edge_locations.sql",
  "004_distributed_telemetry.sql",
  "005_assignment_authority.sql",
];

try {
  const client = await pool.connect();
  try {
    // A stale SQL lock must fail startup rather than block Compose indefinitely.
    await client.query("SET statement_timeout = '60s'");
    await client.query("SET lock_timeout = '30s'");
    // Serialize concurrent starts using the same connection for the lock and SQL.
    await client.query("SELECT pg_advisory_lock(73643101)");
    await client.query("BEGIN");
    const existing = await client.query<{ present: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_tables WHERE schemaname = 'public'
       ) AS present`,
    );
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS demo_bootstrap (
      name TEXT PRIMARY KEY,
      completed_at TIMESTAMPTZ
    )`);
    // Only a genuinely empty database opts in to demo initialization. Existing
    // databases (including ones migrated manually) keep their sensor metadata.
    if (!existing.rows[0].present) {
      await client.query(
        "INSERT INTO demo_bootstrap (name) VALUES ('sensor-1') ON CONFLICT DO NOTHING",
      );
    }
    await client.query("COMMIT");

    for (const fileName of migrationFiles) {
      const applied = await client.query(
        "SELECT 1 FROM schema_migrations WHERE name = $1", [fileName],
      );
      if (applied.rowCount) {
        console.log(`[Migration] Skip ${fileName} (already applied)`);
        continue;
      }
      console.log(`[Migration] Apply ${fileName}`);
      try {
        const migrationFile = new URL(`../sql/${fileName}`, import.meta.url);
        const migrationSql = await readFile(migrationFile, "utf8");
        await client.query("BEGIN");
        await client.query(migrationSql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [fileName]);
        await client.query("COMMIT");
      } catch (error) {
        throw new Error(`Migration ${fileName} failed`, { cause: error });
      }
    }
    console.log("Database migration completed successfully");
  } catch (error) {
    // Also handles an interrupted setup transaction before releasing the lock.
    await client.query("ROLLBACK");
    throw error;
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock(73643101)");
    } finally {
      client.release();
    }
  }
} catch (error) {
  console.error("Database migration failed:", error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
