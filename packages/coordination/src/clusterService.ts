import { readNodeHealth } from "./healthProbe.js";

export type ClusterNode = { id: string; name: string; url: string };
export type ClusterNodeStatus = ClusterNode & {
  status: "UP" | "DOWN";
  role: "FOLLOWER" | "CANDIDATE" | "LEADER" | "UNKNOWN";
  leaderId: string | null;
};

export function createClusterProbe(nodes: ClusterNode[]) {
  return async (): Promise<ClusterNodeStatus[]> => Promise.all(nodes.map(async (node): Promise<ClusterNodeStatus> => {
    try {
      const body = await readNodeHealth(node.url, node.id);
      const role = body.role === "FOLLOWER" || body.role === "CANDIDATE" || body.role === "LEADER" ? body.role : "UNKNOWN";
      const leaderId = typeof body.leaderId === "string" ? body.leaderId : null;
      return { ...node, status: "UP", role, leaderId };
    } catch { return { ...node, status: "DOWN", role: "UNKNOWN", leaderId: null }; }
  }));
}
