import { createClusterProbe } from "@smartedge/coordination";
export type { ClusterNodeStatus } from "@smartedge/coordination";
export const clusterNodes = [1,2,3].map((id) => ({
  id: String(id), name: `edge-${id}`,
  url: process.env[`EDGE_NODE_${id}_URL`] || `http://127.0.0.1:${5000 + id}`,
}));
export const getClusterStatus = createClusterProbe(clusterNodes);
