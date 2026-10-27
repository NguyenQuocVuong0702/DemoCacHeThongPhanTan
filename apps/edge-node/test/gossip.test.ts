import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ID = "1";
process.env.PEERS = "";

const {
  getClusterKnowledge,
  mergeClusterKnowledge,
  updatePeerStatus,
} = await import("../src/gossip.js");
const { handleCoordinatorMessage } = await import("../src/election.js");

function member(nodeId: string) {
  const record = getClusterKnowledge().find((item) => item.nodeId === nodeId);
  assert.ok(record, `Missing member ${nodeId}`);
  return record;
}

test("a later heartbeat observation cannot mask an older owner report", () => {
  updatePeerStatus("3", "UP");
  const owner = {
    nodeId: "3", status: "UP", role: "LEADER", leaderId: "3",
    updatedAt: "2020-01-01T00:00:00.000Z",
  };
  mergeClusterKnowledge([owner]);
  assert.deepEqual(member("3"), owner);
});

test("new owner election state merges while a direct heartbeat still says DOWN", () => {
  const owner = {
    nodeId: "2", status: "UP", role: "LEADER", leaderId: "2",
    updatedAt: "2020-01-01T00:00:00.000Z",
  };
  mergeClusterKnowledge([owner]);
  updatePeerStatus("2", "DOWN");
  assert.equal(member("2").updatedAt, owner.updatedAt);

  const recovered = {
    ...owner, role: "FOLLOWER", leaderId: "3",
    updatedAt: "2020-01-01T00:00:01.000Z",
  };
  mergeClusterKnowledge([recovered]);
  assert.deepEqual(member("2"), { ...recovered, status: "DOWN" });
  updatePeerStatus("2", "UP");
  assert.deepEqual(member("2"), recovered);
});

test("relayed suspicion cannot override direct heartbeat UP", () => {
  const state = {
    nodeId: "4", status: "UP", role: "FOLLOWER", leaderId: "3",
    updatedAt: "2020-01-01T00:00:00.000Z",
  };
  mergeClusterKnowledge([state]);
  updatePeerStatus("4", "UP");
  const relayed = {
    ...state, status: "DOWN", updatedAt: "2020-01-01T00:00:01.000Z",
  };
  mergeClusterKnowledge([relayed]);
  assert.deepEqual(member("4"), { ...relayed, status: "UP" });
});

test("stale, equal-version and malformed gossip cannot replace newer owner state", () => {
  const latest = {
    nodeId: "5", status: "UP", role: "FOLLOWER", leaderId: "3",
    updatedAt: "2020-01-01T00:00:02.000Z",
  };
  mergeClusterKnowledge([latest]);
  mergeClusterKnowledge([
    { ...latest, role: "LEADER", leaderId: "5", updatedAt: "2020-01-01T00:00:01.000Z" },
    { ...latest, role: "LEADER", leaderId: "5" },
    { ...latest, role: "INVALID", updatedAt: "2020-01-01T00:00:03.000Z" },
    { ...latest, updatedAt: "invalid-date" },
    null,
  ]);
  assert.deepEqual(member("5"), latest);
});

test("only local election state can replace self; reading does not manufacture versions", () => {
  handleCoordinatorMessage("3");
  const local = member("1");
  assert.equal(local.role, "FOLLOWER");
  assert.equal(local.leaderId, "3");
  mergeClusterKnowledge([{
    ...local, role: "LEADER", leaderId: "1", updatedAt: "2099-01-01T00:00:00.000Z",
  }]);
  assert.deepEqual(member("1"), local);
  assert.deepEqual(member("1"), local);
});

test("owner state changes within one millisecond receive distinct versions", () => {
  const originalNow = Date.now;
  const fixedNow = originalNow() + 60_000;
  Date.now = () => fixedNow;
  try {
    handleCoordinatorMessage("1");
    const first = member("1");
    assert.equal(Date.parse(first.updatedAt), fixedNow);
    handleCoordinatorMessage("3");
    const second = member("1");
    assert.equal(second.leaderId, "3");
    assert.equal(Date.parse(second.updatedAt), fixedNow + 1);
  } finally {
    Date.now = originalNow;
  }
});
