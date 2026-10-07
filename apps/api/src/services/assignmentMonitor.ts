import { pool } from "../db.js";
import { assignSensor } from "./assignmentService.js";
import { getClusterStatus } from "./clusterService.js";

type AssignedSensorRow = {
  id: string;
  zone: string | null;
  assigned_node_id: string;
};

type NodeZoneRow = {
  id: string;
  zone: string | null;
};

type AssignmentTrigger = "FAILOVER" | "RECOVERY_REBALANCE";

const MONITOR_INTERVAL_MS = 3_000;

let monitorStarted = false;
let monitorRoundInProgress = false;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

async function runAssignmentMonitorRound(): Promise<void> {
  if (monitorRoundInProgress) {
    return;
  }

  monitorRoundInProgress = true;

  try {
    const [clusterStatus, nodesResult, sensorsResult] = await Promise.all([
      getClusterStatus(),
      pool.query<NodeZoneRow>("SELECT id, zone FROM nodes"),
      pool.query<AssignedSensorRow>(
        `SELECT id, zone, assigned_node_id
         FROM sensors
         WHERE assigned_node_id IS NOT NULL`,
      ),
    ]);
    const upNodeIds = new Set(
      clusterStatus
        .filter((node) => node.status === "UP")
        .map((node) => node.id),
    );
    const nodesById = new Map(
      nodesResult.rows.map((node) => [node.id, node]),
    );

    for (const sensor of sensorsResult.rows) {
      const assignedNodeIsUp = upNodeIds.has(sensor.assigned_node_id);
      let trigger: AssignmentTrigger | null = null;

      if (!assignedNodeIsUp) {
        trigger = "FAILOVER";
      } else if (sensor.zone) {
        const assignedNode = nodesById.get(sensor.assigned_node_id);
        const sameZoneNodeIsUp = nodesResult.rows.some(
          (node) => node.zone === sensor.zone && upNodeIds.has(node.id),
        );

        if (assignedNode?.zone !== sensor.zone && sameZoneNodeIsUp) {
          trigger = "RECOVERY_REBALANCE";
        }
      }

      if (!trigger) {
        continue;
      }

      try {
        const result = await assignSensor(sensor.id);

        if (!result.ok) {
          if (result.reason === "NO_AVAILABLE_EDGE_NODE") {
            console.warn(
              `[Assignment] No available edge node for sensor ${sensor.id}`,
            );
          } else {
            console.warn(
              `[Assignment] Sensor ${sensor.id} could not be reassigned: ${result.message}`,
            );
          }

          continue;
        }

        if (result.assignment.assignedNodeId === sensor.assigned_node_id) {
          continue;
        }

        if (
          trigger === "RECOVERY_REBALANCE" &&
          result.assignment.strategy === "SAME_ZONE"
        ) {
          console.log(
            `[Assignment] Sensor ${sensor.id} rebalanced from node ${sensor.assigned_node_id} to node ${result.assignment.assignedNodeId} using SAME_ZONE`,
          );
        } else {
          console.log(
            `[Assignment] Sensor ${sensor.id} reassigned from node ${sensor.assigned_node_id} to node ${result.assignment.assignedNodeId} using ${result.assignment.strategy}`,
          );
        }
      } catch (error) {
        const action =
          trigger === "RECOVERY_REBALANCE" ? "rebalance" : "reassign";
        console.error(
          `[Assignment] Failed to ${action} sensor ${sensor.id}: ${errorMessage(error)}`,
        );
      }
    }
  } catch (error) {
    console.error(
      `[Assignment] Monitor cycle failed: ${errorMessage(error)}`,
    );
  } finally {
    monitorRoundInProgress = false;
  }
}

export function startAssignmentMonitor(): void {
  if (monitorStarted) {
    return;
  }

  monitorStarted = true;
  setInterval(() => {
    void runAssignmentMonitorRound();
  }, MONITOR_INTERVAL_MS);
}
