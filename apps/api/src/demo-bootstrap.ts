import "dotenv/config";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { pool } from "./db.js";
import type { ClusterNodeStatus } from "./services/clusterService.js";
import { assignSensor } from "./services/assignmentService.js";

type DemoSensor = { id: string; name: string; zone: string };
const sensors = JSON.parse(await readFile(new URL("../../../config/demo-sensors.json", import.meta.url), "utf8")) as DemoSensor[];
const apiUrl = process.env.DEMO_API_URL || "http://api:4000";
const timeoutSeconds = Number(process.env.DEMO_BOOTSTRAP_TIMEOUT_SECONDS || 120);
if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) throw new Error("Invalid DEMO_BOOTSTRAP_TIMEOUT_SECONDS");
const deadline = Date.now() + timeoutSeconds * 1000;

async function waitFor(name: string, check: () => Promise<boolean>): Promise<void> {
  let lastError = "Not ready";
  while (Date.now() < deadline) {
    try { if (await check()) return; } catch (error) { lastError = String(error); }
    await delay(2000);
  }
  throw new Error(`${name}: timeout after ${timeoutSeconds}s (${lastError})`);
}

try {
  // Serialize concurrent bootstraps. This is independent of sensor row locks
  // used by the API and telemetry processing transactions.
  const client = await pool.connect();
  try {
    await client.query("SET statement_timeout = '60s'");
    await client.query("SELECT pg_advisory_lock(73643102)");
    for (const sensor of sensors) {
      await client.query("BEGIN");
      const marker = await client.query(
        "INSERT INTO demo_bootstrap (name) VALUES ($1) ON CONFLICT DO NOTHING RETURNING name",
        [`phase-a:${sensor.name}`],
      );
      if (marker.rowCount) {
        // Register real configured simulator devices before any sample arrives.
        // Existing names, zones and non-NULL assignments are never replaced.
        await client.query(
          "INSERT INTO sensors (id, name, zone) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING",
          [sensor.id, sensor.name, sensor.zone],
        );
        // An old completed bootstrap proves this sensor was already configured:
        // preserve even an intentionally cleared zone on upgrade.
        await client.query(
          `UPDATE sensors SET zone = $2 WHERE id = $1 AND zone IS NULL AND assigned_node_id IS NULL
           AND NOT EXISTS (SELECT 1 FROM demo_bootstrap WHERE name = $3 AND completed_at IS NOT NULL)`,
          [sensor.id, sensor.zone, sensor.name],
        );
      }
      await client.query("COMMIT");
    }

    let stable = 0;
    await waitFor("Stable cluster", async () => {
      const response = await fetch(`${apiUrl}/api/cluster`, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error(`Cluster HTTP ${response.status}`);
      const { nodes } = await response.json() as { nodes: ClusterNodeStatus[] };
      const ready = nodes.length === 3 && ["1", "2", "3"].every((id) =>
        nodes.some((n) => n.id === id && n.status === "UP" && n.leaderId === "3")) &&
        nodes.filter((n) => n.role === "LEADER").length === 1 && nodes.some((n) => n.id === "3" && n.role === "LEADER");
      stable = ready ? stable + 1 : 0;
      return stable >= 3;
    });

    for (const sensor of sensors) {
      const marker = await client.query(
        "SELECT 1 FROM demo_bootstrap WHERE name = $1 AND completed_at IS NULL", [`phase-a:${sensor.name}`],
      );
      if (!marker.rowCount) {
        console.log(`[Demo] ${sensor.name}: initialization already complete; preserve metadata.`);
        continue;
      }
      const previouslyConfigured = await client.query(
        `SELECT 1 FROM sensors s WHERE s.id = $1 AND s.assigned_node_id IS NULL
         AND EXISTS (SELECT 1 FROM demo_bootstrap WHERE name = $2 AND completed_at IS NOT NULL)`,
        [sensor.id, sensor.name],
      );
      if (previouslyConfigured.rowCount) throw new Error(`${sensor.name}: existing assignment was cleared; preserve it and configure explicitly`);
      let result: Awaited<ReturnType<typeof assignSensor>> | undefined;
      await waitFor(`Leader assignment for ${sensor.name}`, async () => {
        result = await assignSensor(sensor.id, { onlyIfUnassigned: true });
        if (!result.ok && result.reason !== "NO_ASSIGNMENT_LEADER") throw new Error(result.message);
        return result.ok;
      });
      if (!result?.ok) throw new Error(`${sensor.name}: no leader assignment; metadata preserved`);
      console.log(`[Demo] ${sensor.name}: zone=${result.assignment.sensorZone} edge=${result.assignment.assignedNodeId} strategy=${result.assignment.strategy}`);
      await client.query("UPDATE demo_bootstrap SET completed_at = NOW() WHERE name = $1", [`phase-a:${sensor.name}`]);
    }
    await client.query("UPDATE demo_bootstrap SET completed_at = NOW() WHERE name = 'sensor-1' AND completed_at IS NULL");
    // Assignment now exists, so receiving the first real sample cannot deadlock
    // with registration. No fake readings are created by bootstrap.
    await waitFor("Real telemetry for all demo sensors", async () => {
      const result = await client.query<{ count: string }>(
        "SELECT COUNT(DISTINCT sensor_id) AS count FROM telemetry_messages WHERE sensor_id = ANY($1::text[])",
        [sensors.map((s) => s.id)],
      );
      return Number(result.rows[0].count) === sensors.length;
    });
    console.log(`[Demo] Bootstrap completed: ${sensors.length} configured sensors have real telemetry.`);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    try { await client.query("SELECT pg_advisory_unlock(73643102)"); } finally { client.release(); }
  }
} catch (error) {
  console.error("[Demo] Bootstrap failed:", error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
