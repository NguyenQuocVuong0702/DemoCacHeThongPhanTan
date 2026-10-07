import type { Peer } from "./config.js";

export type PeerStatus = {
  id: string;
  url: string;
  status: "UP" | "DOWN" | "UNKNOWN";
  lastSeen: string | null;
};

export type PeerStatusChangeHandler = (
  peer: PeerStatus,
  previousStatus: PeerStatus["status"],
) => void | Promise<void>;

const HEARTBEAT_INTERVAL_MS = 2_000;
const HEARTBEAT_TIMEOUT_MS = 1_000;
const peerStatuses = new Map<string, PeerStatus>();

let heartbeatTimer: NodeJS.Timeout | undefined;
let statusChangeHandler: PeerStatusChangeHandler | undefined;

function updatePeerStatus(
  peer: PeerStatus,
  status: PeerStatus["status"],
): void {
  const previousStatus = peer.status;

  if (previousStatus === status) {
    return;
  }

  peer.status = status;

  if (!statusChangeHandler) {
    return;
  }

  try {
    void Promise.resolve(
      statusChangeHandler({ ...peer }, previousStatus),
    ).catch(() => {
      // Callback failures must not interrupt the heartbeat loop.
    });
  } catch {
    // Synchronous callback failures must not interrupt the heartbeat loop.
  }
}

async function checkPeer(peer: PeerStatus): Promise<void> {
  try {
    const baseUrl = peer.url.replace(/\/$/, "");
    const response = await fetch(`${baseUrl}/health`, {
      signal: AbortSignal.timeout(HEARTBEAT_TIMEOUT_MS),
    });

    if (!response.ok) {
      updatePeerStatus(peer, "DOWN");
      return;
    }

    peer.lastSeen = new Date().toISOString();
    updatePeerStatus(peer, "UP");
  } catch {
    updatePeerStatus(peer, "DOWN");
  }
}

async function checkPeers(): Promise<void> {
  await Promise.all([...peerStatuses.values()].map(checkPeer));
}

export function startHeartbeatMonitoring(
  peers: Peer[],
  onStatusChange?: PeerStatusChangeHandler,
): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
  }

  statusChangeHandler = onStatusChange;
  peerStatuses.clear();

  for (const peer of peers) {
    peerStatuses.set(peer.id, {
      ...peer,
      status: "UNKNOWN",
      lastSeen: null,
    });
  }

  heartbeatTimer = setInterval(() => {
    void checkPeers();
  }, HEARTBEAT_INTERVAL_MS);
}

export function getPeerStatuses(): PeerStatus[] {
  return [...peerStatuses.values()].map((peer) => ({ ...peer }));
}
