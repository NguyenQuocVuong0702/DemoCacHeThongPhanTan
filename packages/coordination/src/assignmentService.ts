import type { Pool, PoolClient } from "pg";
import type { ClusterNodeStatus } from "./clusterService.js";
import { assignmentLoads, planReconciliation, selectNode, type PlacementNode, type PlacementSensor } from "./assignmentPolicy.js";
import { lockAndValidateAuthority, setAuthorityContext, type AssignmentAuthority } from "./lease.js";

export type SensorAssignment = {
  sensorId: string; sensorZone: string; assignedNodeId: string;
  assignedNodeName: string; assignedNodeZone: string | null;
  // Keep the existing API/Dashboard enum; the fallback selection algorithm is
  // LEAST_LOADED_FALLBACK, recorded explicitly in monitor logs.
  strategy: "SAME_ZONE" | "FALLBACK";
};
export type AssignSensorResult = { ok: true; assignment: SensorAssignment } | {
  ok: false; reason: "SENSOR_NOT_FOUND" | "SENSOR_HAS_NO_ZONE" | "NO_AVAILABLE_EDGE_NODE" | "NO_ASSIGNMENT_LEADER"; message: string;
};

async function withAssignmentsLocked<T>(
  pool: Pool, authority: AssignmentAuthority,
  work: (client: PoolClient, sensors: PlacementSensor[], nodes: PlacementNode[]) => Promise<T>,
): Promise<T> {
  authority.assertCurrent();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '10s'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '4s'");
    await setAuthorityContext(client, authority);
    // Sensor locks precede the authority lock: a task blocked on processing
    // must not prevent a new leader taking over and fencing that stale task.
    await client.query("SELECT pg_advisory_xact_lock(73643103)");
    const sensors = await client.query<PlacementSensor>(
      "SELECT id, zone, assigned_node_id FROM sensors ORDER BY id FOR UPDATE",
    );
    const nodes = await client.query<PlacementNode>("SELECT id, name, zone FROM nodes");
    await lockAndValidateAuthority(client, authority);
    authority.assertCurrent();
    const result = await work(client, sensors.rows, nodes.rows);
    await lockAndValidateAuthority(client, authority);
    authority.assertCurrent();
    // The deferred DB trigger also validates at COMMIT if JavaScript pauses.
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally { client.release(); }
}

export function createAssignmentService(pool: Pool, getClusterStatus: () => Promise<ClusterNodeStatus[]>) {
async function assignSensor(
  sensorId: string,
  authority: AssignmentAuthority,
  options: { onlyIfUnassigned?: boolean; clusterStatus?: ClusterNodeStatus[] } = {},
): Promise<AssignSensorResult> {
  // Network probes run outside the transaction. Tests can supply an explicit
  // snapshot internally; HTTP controllers never accept one from the request.
  authority.assertCurrent();
  const cluster = options.clusterStatus ?? await getClusterStatus();
  const up = new Set(cluster.filter((n) => n.status === "UP").map((n) => n.id));
  return withAssignmentsLocked(pool, authority, async (client, sensors, nodes) => {
    const sensor = sensors.find((s) => s.id === sensorId);
    if (!sensor) return { ok: false, reason: "SENSOR_NOT_FOUND", message: "Sensor not found" };
    if (!sensor.zone) return { ok: false, reason: "SENSOR_HAS_NO_ZONE", message: "Sensor has no zone" };
    const loads = assignmentLoads(sensors);
    if (sensor.assigned_node_id) loads.set(sensor.assigned_node_id, (loads.get(sensor.assigned_node_id) ?? 1) - 1);
    const preserved = options.onlyIfUnassigned && sensor.assigned_node_id
      ? nodes.find((node) => node.id === sensor.assigned_node_id) : undefined;
    const selected = preserved ?? selectNode(sensor.zone, nodes.filter((n) => up.has(n.id)), loads)?.node;
    if (!selected) return { ok: false, reason: "NO_AVAILABLE_EDGE_NODE", message: "No available edge node" };
    if (!preserved && selected.id !== sensor.assigned_node_id) {
      authority.assertCurrent();
      await client.query("SELECT set_config('smartedge.assignment_reason',$1,true)", [options.onlyIfUnassigned ? "BOOTSTRAP" : "MANUAL"]);
      await client.query("UPDATE sensors SET assigned_node_id=$1 WHERE id=$2", [selected.id, sensor.id]);
    }
    return { ok: true, assignment: {
      sensorId: sensor.id, sensorZone: sensor.zone, assignedNodeId: selected.id,
      assignedNodeName: selected.name, assignedNodeZone: selected.zone,
      strategy: selected.zone === sensor.zone ? "SAME_ZONE" : "FALLBACK",
    } };
  });
}

async function reconcileAssignments(authority: AssignmentAuthority, clusterStatus?: ClusterNodeStatus[]) {
  authority.assertCurrent();
  const cluster = clusterStatus ?? await getClusterStatus();
  const up = new Set(cluster.filter((n) => n.status === "UP").map((n) => n.id));
  return withAssignmentsLocked(pool, authority, async (client, sensors, nodes) => {
    const plan = planReconciliation(sensors, nodes, up);
    // Plan is sensor-ID ordered and updates projected load after every move.
    // All changes commit together; Phase A processors wait on the same rows.
    for (const change of plan.changes) {
      authority.assertCurrent();
      await client.query("SELECT set_config('smartedge.assignment_reason',$1,true)", [change.trigger]);
      await client.query("UPDATE sensors SET assigned_node_id=$1 WHERE id=$2", [change.assignedNodeId, change.sensorId]);
    }
    return plan;
  });
}
return { assignSensor, reconcileAssignments };
}
