import "dotenv/config";

import { Pool } from "pg";

const databaseUrl =
  process.env.DATABASE_URL ||
  "postgresql://smartedge:smartedge@localhost:5432/smartedge";

export const pool = new Pool({
  connectionString: databaseUrl,
});
