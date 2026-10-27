import type { AssignSensorResult } from "@smartedge/coordination";
import { pool } from "../db.js";
import { clusterNodes } from "./clusterService.js";
export type { AssignSensorResult, SensorAssignment } from "@smartedge/coordination";

// API/bootstrap only forward requests. No placement or assignment SQL here.
export async function assignSensor(sensorId: string, options: { onlyIfUnassigned?: boolean } = {}): Promise<AssignSensorResult> {
  const unavailable: AssignSensorResult = { ok: false, reason: "NO_ASSIGNMENT_LEADER", message: "No valid assignment leader; retry after election/lease recovery" };
  const lease = await pool.query<{ holder_node_id: string; epoch: string }>(
    `SELECT holder_node_id,epoch::text FROM assignment_authority
     WHERE singleton=true AND holder_node_id IS NOT NULL AND lease_until>clock_timestamp()`,
  );
  const owner = lease.rows[0];
  const leader = clusterNodes.find((node) => node.id === owner?.holder_node_id);
  if (!owner || !leader) return unavailable;
  try {
    const response = await fetch(`${leader.url.replace(/\/+$/, "")}/assignments/${encodeURIComponent(sensorId)}`, {
      method: "POST", headers: { "content-type": "application/json", "x-assignment-epoch": owner.epoch },
      body: JSON.stringify({ onlyIfUnassigned: options.onlyIfUnassigned === true }),
      signal: AbortSignal.timeout(8000),
    });
    const result = await response.json() as AssignSensorResult;
    if (!result || typeof result.ok !== "boolean") return unavailable;
    console.log(`[AssignmentProxy] sensor=${sensorId} leader=${leader.id} epoch=${owner.epoch} HTTP=${response.status}`);
    return result;
  } catch { return unavailable; }
}
