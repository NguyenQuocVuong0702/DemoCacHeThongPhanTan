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
// Heartbeat owns local reachability, not a peer's role/leader version. Relaying
// a suspicion must not make that peer's last known election state newer.
const observedPeerStatuses = new Map<string, "UP" | "DOWN">();
const UNKNOWN_STATE_UPDATED_AT = new Date(0).toISOString();

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
    // Only the owner versions its election state; keep changes within the same
    // millisecond ordered without advancing the version on reads or relays.
    updatedAt: new Date(Math.max(
      Date.now(),
      current ? Date.parse(current.updatedAt) + 1 : 0,
    )).toISOString(),
  });
}

export function updatePeerStatus(
  peerId: string,
  status: "UP" | "DOWN",
): void {
  if (peerId === nodeId) {
    return;
  }

  observedPeerStatuses.set(peerId, status);
  const current = clusterKnowledge.get(peerId);

  if (current?.status === status) {
    return;
  }

  clusterKnowledge.set(peerId, {
    nodeId: peerId,
    status,
    role: current?.role ?? "FOLLOWER",
    leaderId: current?.leaderId ?? null,
    // A placeholder has no owner report yet. Any real owner version must beat
    // it, even if the heartbeat observation was made later than that report.
    updatedAt: current?.updatedAt ?? UNKNOWN_STATE_UPDATED_AT,
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
      clusterKnowledge.set(record.nodeId, {
        ...record,
        // Direct heartbeat evidence wins over relayed UP/DOWN observations.
        // The newer owner role/leader/version is still allowed to converge.
        status: observedPeerStatuses.get(record.nodeId) ?? record.status,
      });
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
