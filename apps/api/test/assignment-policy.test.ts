import assert from "node:assert/strict";
import test from "node:test";
import { assignmentLoads, planReconciliation, selectNode, type PlacementNode, type PlacementSensor } from "../src/services/assignmentPolicy.js";

const nodes: PlacementNode[] = [
  { id: "1", name: "edge-1", zone: "hanoi" },
  { id: "2", name: "edge-2", zone: "danang" },
  { id: "3", name: "edge-3", zone: "hcm" },
];
const sensors: PlacementSensor[] = Array.from({ length: 6 }, (_, i) => ({
  id: String(i + 1), zone: nodes[Math.floor(i / 2)].zone, assigned_node_id: String(Math.floor(i / 2) + 1),
}));
function apply(changes: ReturnType<typeof planReconciliation>["changes"]) {
  return sensors.map((s) => ({ ...s, assigned_node_id: changes.find((c) => c.sensorId === s.id)?.assignedNodeId ?? s.assigned_node_id }));
}

test("normal cluster does not move any healthy same-zone sensor", () => {
  assert.deepEqual(planReconciliation(sensors, nodes, new Set(["1", "2", "3"])), { changes: [], unavailable: [] });
});
test("same-zone priority beats a less-loaded remote node; ties use numeric ID", () => {
  const sameZone = [{ id: "10", name: "ten", zone: "hanoi" }, ...nodes, { id: "4", name: "four", zone: "hanoi" }];
  const loads = new Map([["1", 8], ["10", 3], ["4", 3], ["2", 0]]);
  assert.equal(selectNode("hanoi", sameZone, loads)?.node.id, "4");
  loads.set("10", 2);
  assert.equal(selectNode("hanoi", sameZone, loads)?.node.id, "10");
  assert.equal(selectNode("hanoi", sameZone, loads)?.strategy, "SAME_ZONE");
});
test("fallback chooses least assigned node, then smallest numeric ID", () => {
  assert.equal(selectNode("other", nodes, new Map([["1", 8], ["2", 2], ["3", 2]]))?.node.id, "2");
  assert.equal(selectNode("other", nodes, new Map([["1", 8], ["2", 2], ["3", 1]]))?.node.id, "3");
  assert.equal(selectNode("other", nodes, new Map())?.strategy, "LEAST_LOADED_FALLBACK");
});
test("edge-3 down splits sensors 5/6 using updated projected loads", () => {
  const before = structuredClone(sensors);
  const result = planReconciliation([...sensors].reverse(), nodes, new Set(["1", "2"]));
  assert.deepEqual(result.changes.map((c) => [c.sensorId, c.assignedNodeId, c.projectedLoad]), [["5", "1", 3], ["6", "2", 3]]);
  assert.ok(result.changes.every((c) => c.trigger === "FAILOVER" && c.strategy === "LEAST_LOADED_FALLBACK"));
  assert.deepEqual(sensors, before);
});
test("recovery returns displaced sensors home once, without oscillation", () => {
  const failed = planReconciliation(sensors, nodes, new Set(["1", "2"]));
  const displaced = apply(failed.changes);
  assert.equal(planReconciliation(displaced, nodes, new Set(["1", "2"])).changes.length, 0);
  const recovered = planReconciliation(displaced, nodes, new Set(["1", "2", "3"]));
  assert.deepEqual(recovered.changes.map((c) => [c.sensorId, c.assignedNodeId, c.trigger]), [["5", "3", "RECOVERY_REBALANCE"], ["6", "3", "RECOVERY_REBALANCE"]]);
  assert.equal(planReconciliation(sensors, nodes, new Set(["1", "2", "3"])).changes.length, 0);
});
test("one UP node receives all failed assignments; DOWN metadata is never a candidate", () => {
  for (const id of ["1", "2", "3"]) {
    const result = planReconciliation(sensors, nodes, new Set([id, "unknown-runtime-id"]));
    assert.equal(result.changes.length, 4);
    assert.ok(result.changes.every((c) => c.assignedNodeId === id));
  }
});
test("no UP nodes preserves the last assignment and reports no available processor", () => {
  const result = planReconciliation(sensors, nodes, new Set());
  assert.equal(result.changes.length, 0);
  assert.equal(result.unavailable.length, 6);
  assert.ok(result.unavailable.every((s) => s.reason === "NO_AVAILABLE_EDGE_NODE"));
});
test("custom healthy fallback, same-zone owner, and user-cleared assignments stay intact", () => {
  const custom = [
    { id: "7", zone: "lab-zone", assigned_node_id: "2" },
    { id: "8", zone: "hanoi", assigned_node_id: null },
    { id: "9", zone: "danang", assigned_node_id: "2" },
  ];
  assert.equal(planReconciliation(custom, nodes, new Set(["1", "2", "3"])).changes.length, 0);
});
test("sensor ID order is numeric and every placement affects the next choice", () => {
  const batch = ["10", "2", "1"].map((id) => ({ id, zone: "remote", assigned_node_id: "3" }));
  const result = planReconciliation(batch, nodes, new Set(["1", "2"]));
  assert.deepEqual(result.changes.map((c) => [c.sensorId, c.assignedNodeId]), [["1", "1"], ["2", "2"], ["10", "1"]]);
  assert.equal(assignmentLoads(batch).get("3"), 3);
});
