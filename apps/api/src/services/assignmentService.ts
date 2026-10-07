import { pool } from "../db.js";
import { getClusterStatus } from "./clusterService.js";

type SensorRow = {
  id: string;
  name: string;
  zone: string | null;
  assigned_node_id: string | null;
};

type NodeRow = {
  id: string;
  name: string;
  zone: string | null;
};

export type SensorAssignment = {
  sensorId: string;
  sensorZone: string;
  assignedNodeId: string;
  assignedNodeName: string;
  assignedNodeZone: string | null;
  strategy: "SAME_ZONE" | "FALLBACK";
};

export type AssignSensorResult =
  | {
      ok: true;
      assignment: SensorAssignment;
    }
  | {
      ok: false;
      reason:
        | "SENSOR_NOT_FOUND"
        | "SENSOR_HAS_NO_ZONE"
        | "NO_AVAILABLE_EDGE_NODE";
      message: string;
    };

export async function assignSensor(
  sensorId: string,
): Promise<AssignSensorResult> {
  const sensorResult = await pool.query<SensorRow>(
    `SELECT id, name, zone, assigned_node_id
     FROM sensors
     WHERE id = $1`,
    [sensorId],
  );
  const sensor = sensorResult.rows[0];

  if (!sensor) {
    return {
      ok: false,
      reason: "SENSOR_NOT_FOUND",
      message: "Sensor not found",
    };
  }

  if (!sensor.zone) {
    return {
      ok: false,
      reason: "SENSOR_HAS_NO_ZONE",
      message: "Sensor has no zone",
    };
  }

  const [nodesResult, clusterStatus] = await Promise.all([
    pool.query<NodeRow>("SELECT id, name, zone FROM nodes"),
    getClusterStatus(),
  ]);
  const upNodeIds = new Set(
    clusterStatus
      .filter((node) => node.status === "UP")
      .map((node) => node.id),
  );
  const availableNodes = nodesResult.rows
    .filter((node) => upNodeIds.has(node.id))
    .sort((left, right) =>
      left.id.localeCompare(right.id, undefined, { numeric: true }),
    );

  const sameZoneNode = availableNodes.find(
    (node) => node.zone === sensor.zone,
  );
  const selectedNode = sameZoneNode ?? availableNodes[0];

  if (!selectedNode) {
    return {
      ok: false,
      reason: "NO_AVAILABLE_EDGE_NODE",
      message: "No available edge node",
    };
  }

  await pool.query(
    `UPDATE sensors
     SET assigned_node_id = $1
     WHERE id = $2`,
    [selectedNode.id, sensor.id],
  );

  return {
    ok: true,
    assignment: {
      sensorId: sensor.id,
      sensorZone: sensor.zone,
      assignedNodeId: selectedNode.id,
      assignedNodeName: selectedNode.name,
      assignedNodeZone: selectedNode.zone,
      strategy: sameZoneNode ? "SAME_ZONE" : "FALLBACK",
    },
  };
}
