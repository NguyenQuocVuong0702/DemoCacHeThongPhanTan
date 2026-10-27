import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import {
  acquireOrRenewLease, releaseLease, createAssignmentService, createClusterProbe,
  AuthorityLostError, type AssignmentAuthority, type LeaseToken,
  createPostgresStream,
} from "@smartedge/coordination";
import { nodeId, nodeName, peers, port } from "./config.js";
import { getElectionGeneration, getElectionState } from "./election.js";

// Separate from telemetry: a failed/blocked lease operation cannot exhaust the
// worker pool. PostgreSQL timeouts also bound a suspended coordinator session.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || "postgresql://smartedge:smartedge@localhost:5432/smartedge",
  application_name: `smartedge-coordinator-${nodeId}`,
  stream: createPostgresStream,
  max: 4, connectionTimeoutMillis: 1500, query_timeout: 6500,
  statement_timeout: 6000, idle_in_transaction_session_timeout: 4000,
});
pool.on("error", (error) => { invalidate(); console.error(`[Coordination][${nodeId}] DB connection lost: ${error.message}`); });
pool.on("connect", (client) => {
  client.on("error", (error) => {
    invalidate();
    console.error(`[Coordination][${nodeId}] active DB connection lost: ${error.message}`);
  });
});
const instanceId = randomUUID();
const probe = createClusterProbe([
  { id: nodeId, name: nodeName, url: `http://127.0.0.1:${port}` },
  ...peers.map((peer) => ({ ...peer, name: `edge-${peer.id}` })),
]);
const service = createAssignmentService(pool, probe);
let token: LeaseToken | undefined;
let leaseGeneration = 0;
let electionGeneration = -1;
let leaseBusy = false;
let monitorBusy = false;
let started = false;
const unavailable = new Set<string>();

function isLocalLeader(): boolean {
  const state = getElectionState();
  return state.role === "LEADER" && state.currentLeaderId === nodeId && !state.electionInProgress;
}
function invalidate(): void { token = undefined; leaseGeneration++; }

function currentAuthority(expectedEpoch?: string): AssignmentAuthority {
  const active = token;
  const localGeneration = leaseGeneration;
  const round = getElectionGeneration();
  const assertCurrent = () => {
    if (!active || !isLocalLeader() || round !== getElectionGeneration() || round !== electionGeneration ||
        localGeneration !== leaseGeneration || token?.epoch !== active.epoch ||
        (expectedEpoch !== undefined && expectedEpoch !== active.epoch)) throw new AuthorityLostError();
  };
  assertCurrent();
  return { ...active!, assertCurrent };
}

async function leaseTick(): Promise<void> {
  if (leaseBusy) return;
  leaseBusy = true;
  try {
    const round = getElectionGeneration();
    if (!isLocalLeader() || (token && electionGeneration !== round)) {
      const previous = token;
      invalidate();
      if (previous) {
        await releaseLease(pool, previous);
        console.log(`[Coordination][RELEASE] node=${nodeId} epoch=${previous.epoch}`);
      }
      return;
    }
    const next = await acquireOrRenewLease(pool, nodeId, instanceId);
    if (!isLocalLeader() || round !== getElectionGeneration()) {
      invalidate();
      if (next) await releaseLease(pool, next);
      return;
    }
    if (!next) { invalidate(); return; }
    if (token?.epoch !== next.epoch) {
      leaseGeneration++;
      console.log(`[Coordination][ACQUIRE] node=${nodeId} instance=${instanceId} epoch=${next.epoch}`);
    }
    electionGeneration = round;
    token = next;
  } catch (error) {
    invalidate();
    console.error(`[Coordination][${nodeId}] lease unavailable; assignment paused:`, error);
  } finally { leaseBusy = false; }
}

async function monitorTick(): Promise<void> {
  if (monitorBusy || !token || !isLocalLeader()) return;
  monitorBusy = true;
  try {
    const authority = currentAuthority();
    const result = await service.reconcileAssignments(authority);
    for (const change of result.changes) {
      console.log(`[Assignment][${change.trigger}][${change.strategy}] coordinator=${nodeId} epoch=${authority.epoch} sensor=${change.sensorId} from=${change.previousNodeId} to=${change.assignedNodeId} projected_load=${change.projectedLoad}`);
    }
    const pending = new Set(result.unavailable.map((state) => state.sensorId));
    for (const state of result.unavailable) if (!unavailable.has(state.sensorId)) {
      console.warn(`[Assignment][${state.reason}] coordinator=${nodeId} epoch=${authority.epoch} sensor=${state.sensorId} processor=NONE last_assignment=${state.previousNodeId}`);
    }
    unavailable.clear();
    for (const id of pending) unavailable.add(id);
  } catch (error) {
    console.warn(`[Coordination][${nodeId}] assignment round aborted:`, error);
  } finally { monitorBusy = false; }
}

export async function assignAsLeader(sensorId: string, onlyIfUnassigned: boolean, expectedEpoch?: string) {
  const authority = currentAuthority(expectedEpoch);
  const result = await service.assignSensor(sensorId, authority, { onlyIfUnassigned });
  console.log(`[Assignment][REQUEST] coordinator=${nodeId} epoch=${authority.epoch} sensor=${sensorId} ok=${result.ok}`);
  return result;
}

export async function getAssignmentAuthority() {
  const result = await pool.query(`SELECT holder_node_id AS "holderNodeId",epoch::text,lease_until AS "leaseUntil",
    lease_until>clock_timestamp() AND holder_node_id IS NOT NULL AS valid FROM assignment_authority WHERE singleton=true`);
  return { nodeId, localEpoch: isLocalLeader() ? token?.epoch ?? null : null, lease: result.rows[0] };
}

export function startAssignmentCoordination(): void {
  if (started) return;
  started = true;
  // Lease lifecycle stays responsive while an assignment waits for a sensor.
  setInterval(() => { void leaseTick(); }, 1000);
  setInterval(() => { void monitorTick(); }, 3000);
  void leaseTick();
}
