import express from "express";

import { nodeId, nodeName, peers, port } from "./config.js";
import {
  getElectionState,
  handleCoordinatorMessage,
  handleElectionMessage,
  startElection,
} from "./election.js";
import {
  getPeerStatuses,
  startHeartbeatMonitoring,
} from "./heartbeat.js";
import {
  getClusterKnowledge,
  mergeClusterKnowledge,
  startGossip,
  updatePeerStatus,
} from "./gossip.js";
import { startMqttSubscriber } from "./mqtt.js";

const app = express();

app.use(express.json());

app.get("/health", (_request, response) => {
  const electionState = getElectionState();

  response.json({
    status: "ok",
    nodeId,
    nodeName,
    role: electionState.role,
    leaderId: electionState.currentLeaderId,
  });
});

app.get("/peers", (_request, response) => {
  response.json({
    nodeId,
    peers,
  });
});

app.get("/cluster-status", (_request, response) => {
  response.json({
    nodeId,
    nodeName,
    peers: getPeerStatuses(),
  });
});

app.post("/gossip", (request, response) => {
  const knowledge = (request.body as { knowledge?: unknown } | undefined)
    ?.knowledge;

  if (!Array.isArray(knowledge)) {
    response.status(400).json({
      error: "knowledge must be an array",
    });
    return;
  }

  mergeClusterKnowledge(knowledge);
  response.json({ ok: true, nodeId });
});

app.get("/gossip/state", (_request, response) => {
  response.json({
    nodeId,
    knowledge: getClusterKnowledge(),
  });
});

app.post("/election", (request, response) => {
  const fromId = (request.body as { fromId?: unknown } | undefined)?.fromId;

  if (typeof fromId !== "string" || !/^\d+$/.test(fromId)) {
    response.status(400).json({
      error: "fromId must be a numeric string",
    });
    return;
  }

  response.json(handleElectionMessage(fromId));
});

app.post("/coordinator", (request, response) => {
  const leaderId = (request.body as { leaderId?: unknown } | undefined)
    ?.leaderId;

  if (typeof leaderId !== "string" || !/^\d+$/.test(leaderId)) {
    response.status(400).json({
      error: "leaderId must be a numeric string",
    });
    return;
  }

  handleCoordinatorMessage(leaderId);
  response.json({ ok: true, nodeId });
});

app.post("/election/start", (_request, response) => {
  setImmediate(() => {
    void startElection();
  });

  response.status(202).json({
    status: "election-started",
    nodeId,
  });
});

app.get("/election/status", (_request, response) => {
  const electionState = getElectionState();

  response.json({
    nodeId,
    role: electionState.role,
    leaderId: electionState.currentLeaderId,
    electionInProgress: electionState.electionInProgress,
  });
});

app.listen(port, () => {
  console.log(`Edge node ${nodeId} is running on port ${port}`);
  startMqttSubscriber();
  startHeartbeatMonitoring(peers, (peer) => {
    if (peer.status === "UP" || peer.status === "DOWN") {
      updatePeerStatus(peer.id, peer.status);
    }

    if (peer.status !== "DOWN") {
      return;
    }

    const { currentLeaderId } = getElectionState();

    if (peer.id !== currentLeaderId) {
      return;
    }

    console.log(`[Heartbeat] Leader ${peer.id} is DOWN`);
    console.log(`[Election] Starting election on node ${nodeId}`);

    return startElection().catch((error: unknown) => {
      console.error("[Election] Election failed:", error);
    });
  });
  startGossip();

  setTimeout(() => {
    console.log(`[Election] Startup election on node ${nodeId}`);

    void startElection().catch((error: unknown) => {
      console.error("[Election] Startup election failed:", error);
    });
  }, 2_500);
});
