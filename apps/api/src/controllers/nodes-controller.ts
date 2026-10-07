import type { Request, Response } from "express";

import { pool } from "../db.js";

export async function getNodes(
  _request: Request,
  response: Response,
): Promise<void> {
  try {
    const result = await pool.query(
      `SELECT
         id,
         name,
         status,
         role,
         zone,
         last_heartbeat AS "lastHeartbeat"
       FROM nodes
       ORDER BY id ASC`,
    );

    response.json({ nodes: result.rows });
  } catch (error) {
    console.error("Failed to get nodes:", error);
    response.status(500).json({ error: "Internal server error" });
  }
}
