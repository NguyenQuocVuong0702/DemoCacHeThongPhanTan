import { nodeId, peers } from "./config.js";
import { getElectionState } from "./election.js";

export type ClusterMemberState = {
  nodeId: string;
  status: "UP" | "DOWN";
  role: "FOLLOWER" | "CANDIDATE" | "LEADER";
  leaderId: string | null;
  updatedAt: string;
};

const GOSSIP_INTERVAL_MS = 3_000;
const GOSSIP_TIMEOUT_MS = 1_000;
const clusterKnowledge = new Map<string, ClusterMemberState>();

let gossipTimer: NodeJS.Timeout | undefined;

function isClusterMemberState(value: unknown): value is ClusterMemberState {
  if (!value || typeof value !== "object") {
    return false;
  }

  const record = value as Partial<ClusterMemberState>;

  return (
    typeof record.nodeId === "string" &&
    (record.status === "UP" || record.status === "DOWN") &&
    (record.role === "FOLLOWER" ||
      record.role === "CANDIDATE" ||
      record.role === "LEADER") &&
    (record.leaderId === null || typeof record.leaderId === "string") &&
    typeof record.updatedAt === "string" &&
    Number.isFinite(Date.parse(record.updatedAt))
  );
}

export function updateLocalState(): void {
  const { role, currentLeaderId } = getElectionState();
  const current = clusterKnowledge.get(nodeId);

  if (
    current?.status === "UP" &&
    current.role === role &&
    current.leaderId === currentLeaderId
  ) {
    return;
  }

  clusterKnowledge.set(nodeId, {
    nodeId,
    status: "UP",
    role,
    leaderId: currentLeaderId,
    updatedAt: new Date().toISOString(),
  });
}

export function updatePeerStatus(
  peerId: string,
  status: "UP" | "DOWN",
): void {
  const current = clusterKnowledge.get(peerId);

  if (current?.status === status) {
    return;
  }

  clusterKnowledge.set(peerId, {
    nodeId: peerId,
    status,
    role: current?.role ?? "FOLLOWER",
    leaderId: current?.leaderId ?? null,
    updatedAt: new Date().toISOString(),
  });
}

export function mergeClusterKnowledge(records: unknown[]): void {
  for (const record of records) {
    if (!isClusterMemberState(record) || record.nodeId === nodeId) {
      continue;
    }

    const current = clusterKnowledge.get(record.nodeId);

    if (
      !current ||
      Date.parse(record.updatedAt) > Date.parse(current.updatedAt)
    ) {
      clusterKnowledge.set(record.nodeId, { ...record });
    }
  }

  updateLocalState();
}

export function getClusterKnowledge(): ClusterMemberState[] {
  updateLocalState();
  return [...clusterKnowledge.values()].map((record) => ({ ...record }));
}

async function gossipOnce(): Promise<void> {
  updateLocalState();

  if (peers.length === 0) {
    return;
  }

  const peer = peers[Math.floor(Math.random() * peers.length)];

  if (!peer) {
    return;
  }

  try {
    const baseUrl = peer.url.replace(/\/+$/, "");
    await fetch(`${baseUrl}/gossip`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ knowledge: getClusterKnowledge() }),
      signal: AbortSignal.timeout(GOSSIP_TIMEOUT_MS),
    });
  } catch {
    // An unavailable peer must not interrupt the gossip loop.
  }
}

export function startGossip(): void {
  if (gossipTimer) {
    clearInterval(gossipTimer);
  }

  updateLocalState();
  gossipTimer = setInterval(() => {
    void gossipOnce();
  }, GOSSIP_INTERVAL_MS);
}

updateLocalState();
