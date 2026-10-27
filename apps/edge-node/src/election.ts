import { nodeId, peers } from "./config.js";

export type ElectionRole = "FOLLOWER" | "CANDIDATE" | "LEADER";

export type ElectionState = {
  role: ElectionRole;
  currentLeaderId: string | null;
  electionInProgress: boolean;
};

export type ElectionMessageResponse = {
  ok: boolean;
  nodeId: string;
};

const REQUEST_TIMEOUT_MS = 1_000;

const electionState: ElectionState = {
  role: "FOLLOWER",
  currentLeaderId: null,
  electionInProgress: false,
};

let electionRound = 0;

// Invalidate assignment tasks begun before a later election/coordinator event.
export function getElectionGeneration(): number { return electionRound; }

async function sendElection(url: string): Promise<boolean> {
  try {
    const baseUrl = url.replace(/\/+$/, "");
    const response = await fetch(`${baseUrl}/election`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fromId: nodeId }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    return response.ok;
  } catch {
    return false;
  }
}

async function broadcastCoordinator(): Promise<void> {
  await Promise.all(
    peers.map(async (peer) => {
      try {
        const baseUrl = peer.url.replace(/\/+$/, "");
        await fetch(`${baseUrl}/coordinator`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ leaderId: nodeId }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch {
        // A peer being unavailable must not interrupt the election.
      }
    }),
  );
}

export function getElectionState(): ElectionState {
  return { ...electionState };
}

export async function startElection(): Promise<void> {
  if (electionState.electionInProgress) {
    return;
  }

  electionState.role = "CANDIDATE";
  electionState.currentLeaderId = null;
  electionState.electionInProgress = true;

  const currentRound = ++electionRound;
  const currentNodeId = Number(nodeId);
  const higherPeers = peers.filter((peer) => Number(peer.id) > currentNodeId);
  const responses = await Promise.all(
    higherPeers.map((peer) => sendElection(peer.url)),
  );

  if (
    currentRound !== electionRound ||
    !electionState.electionInProgress
  ) {
    return;
  }

  if (responses.some(Boolean)) {
    electionState.role = "FOLLOWER";
    electionState.electionInProgress = false;
    return;
  }

  electionState.role = "LEADER";
  electionState.currentLeaderId = nodeId;
  electionState.electionInProgress = false;

  await broadcastCoordinator();
}

export function handleElectionMessage(
  fromId: string,
): ElectionMessageResponse {
  const shouldRespond = Number(nodeId) > Number(fromId);

  if (shouldRespond) {
    setImmediate(() => {
      void startElection();
    });
  }

  return {
    ok: shouldRespond,
    nodeId,
  };
}

export function handleCoordinatorMessage(leaderId: string): void {
  electionRound += 1;
  electionState.currentLeaderId = leaderId;
  electionState.electionInProgress = false;
  electionState.role = leaderId === nodeId ? "LEADER" : "FOLLOWER";
}
