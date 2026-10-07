import type { Request, Response } from "express";

import { pool } from "../db.js";

function parseLimit(value: unknown): number {
  if (typeof value !== "string") {
    return 50;
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    return 50;
  }

  return Math.min(parsed, 500);
}

export async function getSensors(
  _request: Request,
  response: Response,
): Promise<void> {
  try {
    const result = await pool.query(
      `SELECT
         s.id,
         s.name,
         s.zone,
         s.assigned_node_id AS "assignedNodeId",
         n.name AS "assignedNodeName",
         n.zone AS "assignedNodeZone",
         CASE
           WHEN s.assigned_node_id IS NULL OR n.id IS NULL THEN NULL
           WHEN s.zone IS NOT NULL AND n.zone = s.zone THEN 'SAME_ZONE'
           ELSE 'FALLBACK'
         END AS "assignmentStrategy",
         s.created_at AS "createdAt",
         temperature.value AS "latestTemperature",
         humidity.value AS "latestHumidity",
         latest.created_at AS "lastSeen"
       FROM sensors s
       LEFT JOIN nodes n ON s.assigned_node_id = n.id
       LEFT JOIN LATERAL (
         SELECT value
         FROM sensor_readings
         WHERE sensor_id = s.id AND metric = 'temperature'
         ORDER BY created_at DESC, id DESC
         LIMIT 1
       ) temperature ON true
       LEFT JOIN LATERAL (
         SELECT value
         FROM sensor_readings
         WHERE sensor_id = s.id AND metric = 'humidity'
         ORDER BY created_at DESC, id DESC
         LIMIT 1
       ) humidity ON true
       LEFT JOIN LATERAL (
         SELECT created_at
         FROM sensor_readings
         WHERE sensor_id = s.id
         ORDER BY created_at DESC, id DESC
         LIMIT 1
       ) latest ON true
       ORDER BY s.id ASC`,
    );

    response.json({ sensors: result.rows });
  } catch (error) {
    console.error("Failed to get sensors:", error);
    response.status(500).json({ error: "Internal server error" });
  }
}

export async function getSensorReadings(
  request: Request,
  response: Response,
): Promise<void> {
  const sensorId = request.params.id;
  const limit = parseLimit(request.query.limit);

  try {
    const sensorResult = await pool.query(
      "SELECT 1 FROM sensors WHERE id = $1",
      [sensorId],
    );

    if (sensorResult.rows.length === 0) {
      response.status(404).json({ error: "Sensor not found" });
      return;
    }

    const readingsResult = await pool.query(
      `SELECT
         id,
         sensor_id AS "sensorId",
         metric,
         value,
         created_at AS "createdAt"
       FROM sensor_readings
       WHERE sensor_id = $1
       ORDER BY created_at DESC, id DESC
       LIMIT $2`,
      [sensorId, limit],
    );

    response.json({
      sensorId,
      readings: readingsResult.rows,
    });
  } catch (error) {
    console.error(`Failed to get readings for sensor ${sensorId}:`, error);
    response.status(500).json({ error: "Internal server error" });
  }
}
