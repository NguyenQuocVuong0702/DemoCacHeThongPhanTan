type ClusterNode = {
  id: string;
  name: string;
  url: string;
};

export type ClusterNodeStatus = {
  id: string;
  name: string;
  url: string;
  status: "UP" | "DOWN";
  role: "FOLLOWER" | "CANDIDATE" | "LEADER" | "UNKNOWN";
  leaderId: string | null;
};

const nodes: ClusterNode[] = [
  {
    id: "1",
    name: "edge-1",
    url: process.env.EDGE_NODE_1_URL || "http://127.0.0.1:5001",
  },
  {
    id: "2",
    name: "edge-2",
    url: process.env.EDGE_NODE_2_URL || "http://127.0.0.1:5002",
  },
  {
    id: "3",
    name: "edge-3",
    url: process.env.EDGE_NODE_3_URL || "http://127.0.0.1:5003",
  },
];

const validRoles = new Set<ClusterNodeStatus["role"]>([
  "FOLLOWER",
  "CANDIDATE",
  "LEADER",
]);

async function getNodeStatus(node: ClusterNode): Promise<ClusterNodeStatus> {
  try {
    const response = await fetch(`${node.url}/health`, {
      signal: AbortSignal.timeout(1_000),
    });

    if (!response.ok) {
      throw new Error(`Health check returned HTTP ${response.status}`);
    }

    const body = (await response.json()) as {
      role?: unknown;
      leaderId?: unknown;
    };
    const role =
      typeof body.role === "string" &&
      validRoles.has(body.role as ClusterNodeStatus["role"])
        ? (body.role as ClusterNodeStatus["role"])
        : "UNKNOWN";
    const leaderId =
      typeof body.leaderId === "string" || body.leaderId === null
        ? body.leaderId
        : null;

    return {
      ...node,
      status: "UP",
      role,
      leaderId,
    };
  } catch {
    return {
      ...node,
      status: "DOWN",
      role: "UNKNOWN",
      leaderId: null,
    };
  }
}

export function getClusterStatus(): Promise<ClusterNodeStatus[]> {
  return Promise.all(nodes.map(getNodeStatus));
}
