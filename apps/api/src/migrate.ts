import "dotenv/config";

import { readFile } from "node:fs/promises";

import { pool } from "./db.js";

const migrationFiles = [
  "001_initial_schema.sql",
  "002_add_location_fields.sql",
  "003_seed_edge_locations.sql",
];

let migrationFailed = false;

try {
  for (const fileName of migrationFiles) {
    const migrationFile = new URL(`../sql/${fileName}`, import.meta.url);
    const migrationSql = await readFile(migrationFile, "utf8");
    await pool.query(migrationSql);
  }

  console.log("Database migration completed successfully");
} catch (error) {
  migrationFailed = true;
  console.error("Database migration failed:", error);
} finally {
  await pool.end();
}

if (migrationFailed) {
  process.exit(1);
}
