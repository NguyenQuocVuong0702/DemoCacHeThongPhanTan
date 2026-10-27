export type PlacementSensor = { id: string; zone: string | null; assigned_node_id: string | null };
export type PlacementNode = { id: string; name: string; zone: string | null };
export type SelectionStrategy = "SAME_ZONE" | "LEAST_LOADED_FALLBACK";
export type AssignmentChange = {
  sensorId: string; previousNodeId: string; assignedNodeId: string;
  trigger: "FAILOVER" | "RECOVERY_REBALANCE";
  strategy: SelectionStrategy; projectedLoad: number;
};
export type UnavailableAssignment = { sensorId: string; previousNodeId: string; reason: "NO_AVAILABLE_EDGE_NODE" | "SENSOR_HAS_NO_ZONE" };

export function compareIds(left: string, right: string): number {
  return left.localeCompare(right, "en", { numeric: true }) || left.localeCompare(right, "en");
}

export function assignmentLoads(sensors: PlacementSensor[]): Map<string, number> {
  const loads = new Map<string, number>();
  for (const sensor of sensors) if (sensor.assigned_node_id !== null) {
    loads.set(sensor.assigned_node_id, (loads.get(sensor.assigned_node_id) ?? 0) + 1);
  }
  return loads;
}

export function selectNode(zone: string, availableNodes: PlacementNode[], loads: Map<string, number>) {
  const sameZone = availableNodes.filter((node) => node.zone === zone);
  const candidates = sameZone.length ? sameZone : availableNodes;
  const node = [...candidates].sort((left, right) =>
    (loads.get(left.id) ?? 0) - (loads.get(right.id) ?? 0) || compareIds(left.id, right.id),
  )[0];
  return node ? { node, strategy: sameZone.length ? "SAME_ZONE" as const : "LEAST_LOADED_FALLBACK" as const } : undefined;
}

export function planReconciliation(sensors: PlacementSensor[], nodes: PlacementNode[], upNodeIds: ReadonlySet<string>) {
  const available = nodes.filter((node) => upNodeIds.has(node.id));
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const loads = assignmentLoads(sensors);
  const changes: AssignmentChange[] = [];
  const unavailable: UnavailableAssignment[] = [];
  for (const sensor of [...sensors].sort((a, b) => compareIds(a.id, b.id))) {
    const previousNodeId = sensor.assigned_node_id;
    // A user-cleared assignment is not a failed assignment to auto-initialize.
    if (previousNodeId === null) continue;
    const owner = nodesById.get(previousNodeId);
    const trigger = !upNodeIds.has(previousNodeId) || !owner ? "FAILOVER"
      : sensor.zone && owner.zone !== sensor.zone && available.some((n) => n.zone === sensor.zone) ? "RECOVERY_REBALANCE" : null;
    // Healthy same-zone and healthy fallback assignments stay put. Load changes
    // alone do not justify moving a sensor or undoing a valid custom placement.
    if (!trigger) continue;
    if (!sensor.zone || !available.length) {
      unavailable.push({ sensorId: sensor.id, previousNodeId,
        reason: !available.length ? "NO_AVAILABLE_EDGE_NODE" : "SENSOR_HAS_NO_ZONE" });
      continue;
    }
    loads.set(previousNodeId, (loads.get(previousNodeId) ?? 1) - 1);
    const selected = selectNode(sensor.zone, available, loads)!;
    const projectedLoad = (loads.get(selected.node.id) ?? 0) + 1;
    loads.set(selected.node.id, projectedLoad);
    changes.push({ sensorId: sensor.id, previousNodeId, assignedNodeId: selected.node.id,
      trigger, strategy: selected.strategy, projectedLoad });
  }
  return { changes, unavailable };
}
