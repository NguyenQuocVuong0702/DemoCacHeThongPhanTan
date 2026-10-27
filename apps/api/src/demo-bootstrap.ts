import "dotenv/config";
import { setTimeout as delay } from "node:timers/promises";
import { pool } from "./db.js";
import type { ClusterNodeStatus } from "./services/clusterService.js";
import type { SensorAssignment } from "./services/assignmentService.js";

const apiUrl = process.env.DEMO_API_URL || "http://api:4000";
const timeoutSeconds = Number(process.env.DEMO_BOOTSTRAP_TIMEOUT_SECONDS || 120);
if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
  throw new Error("DEMO_BOOTSTRAP_TIMEOUT_SECONDS must be a positive number");
}
const deadline = Date.now() + timeoutSeconds * 1000;

async function request<T>(path: string, method = "GET"): Promise<T> {
  const response = await fetch(`${apiUrl}${path}`, {
    method, signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`${method} ${path}: HTTP ${response.status}`);
  return response.json();
}

try {
  // The migration runner creates this marker only on a completely new database.
  const marker = await pool.query(
    "SELECT 1 FROM demo_bootstrap WHERE name = 'sensor-1' AND completed_at IS NULL",
  );
  if (!marker.rowCount) {
    console.log("[Demo] Existing database: preserve sensor zones and assignments.");
  } else {
    let stableSamples = 0;
    let lastError = "Waiting for telemetry and a stable cluster";
    let ready = false;
    while (Date.now() < deadline) {
      try {
        const cluster = await request<{ nodes: ClusterNodeStatus[] }>("/api/cluster");
        const nodes = cluster.nodes;
        const stable = nodes.length === 3 &&
          ["1", "2", "3"].every((id) => nodes.some((n) => n.id === id && n.status === "UP" && n.leaderId === "3")) &&
          nodes.filter((n) => n.role === "LEADER").length === 1 &&
          nodes.some((n) => n.id === "3" && n.role === "LEADER");
        stableSamples = stable ? stableSamples + 1 : 0;
        const sensor = await pool.query(
          `SELECT 1 FROM sensors WHERE id = '1' AND EXISTS (
             SELECT 1 FROM sensor_readings WHERE sensor_id = '1'
           )`,
        );
        if (stableSamples >= 3 && sensor.rowCount) {
          ready = true;
          break;
        }
      } catch (error) {
        stableSamples = 0;
        lastError = String(error);
      }
      await delay(2000);
    }
    if (!ready) throw new Error(`Demo bootstrap timed out after ${timeoutSeconds}s: ${lastError}`);

    // Do not insert a fake sensor. Do not replace a zone or assignment that was
    // already set, even when resuming an interrupted first bootstrap.
    await pool.query(`UPDATE sensors SET zone = 'hanoi'
      WHERE id = '1' AND zone IS NULL AND assigned_node_id IS NULL`);
    const sensor = await pool.query<{ zone: string | null; assigned_node_id: string | null }>(
      "SELECT zone, assigned_node_id FROM sensors WHERE id = '1'",
    );
    if (!sensor.rows[0].assigned_node_id) {
      const assignment = await request<SensorAssignment>("/api/sensors/1/assign", "POST");
      if (sensor.rows[0].zone === "hanoi" &&
          (assignment.assignedNodeId !== "1" || assignment.strategy !== "SAME_ZONE")) {
        throw new Error(`Unexpected initial assignment: ${JSON.stringify(assignment)}`);
      }
      console.log("[Demo] Initial assignment:", assignment);
    } else {
      console.log("[Demo] Sensor already assigned; keeping existing metadata.");
    }
    await pool.query("UPDATE demo_bootstrap SET completed_at = NOW() WHERE name = 'sensor-1'");
    console.log("[Demo] Bootstrap completed.");
  }
} catch (error) {
  console.error("[Demo] Bootstrap failed:", error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
