// Deliberate role conflicts and queued work on the live Docker demo. Only this
// run's UUID sensor rows are created/deleted; existing sensors are never edited.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { setAuthorityContext } from '@smartedge/coordination';

assert.equal(process.env.LEADER_COORDINATION_TESTING, '1', 'Opt in on a test/demo stack');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 3000 });
const probeId = `lc-${randomUUID()}`;
const dualId = `${probeId}-dual`;
const api = process.env.API_URL || 'http://127.0.0.1:4000';
const edge = (id) => `http://127.0.0.1:${5000 + Number(id)}`;
const post = (base, path, body) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}), signal: AbortSignal.timeout(10000) });
const get = async (base, path) => { const r = await fetch(base + path, { signal: AbortSignal.timeout(3000) }); assert.ok(r.ok); return r.json(); };
const lease = async () => (await pool.query(`SELECT holder_node_id AS "nodeId",holder_instance_id AS "instanceId",epoch::text,
  lease_until>clock_timestamp() AND holder_node_id IS NOT NULL AS valid FROM assignment_authority WHERE singleton=true`)).rows[0];
async function wait(check, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await delay(100); }
  throw new Error(`Timeout: ${label}`);
}
async function forgedWrite(token) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN'); await setAuthorityContext(client, token);
    await client.query('UPDATE sensors SET assigned_node_id=$1 WHERE id=$2', ['1', probeId]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}
let blocker;
let oldRequest;
try {
  const initial = await get(api, '/api/sensors');
  assert.equal(initial.sensors.length, 6, 'Requires standard six-sensor demo');
  await wait(async () => { const l = await lease(); return l.valid && l.nodeId === '3'; }, 'initial lease3');
  const first = await lease();
  console.log('INITIAL authority:', JSON.stringify(first));
  await pool.query("INSERT INTO sensors(id,name,zone) VALUES($1,$1,'hcm')", [probeId]);
  const assigned = await post(api, `/api/sensors/${probeId}/assign`);
  assert.equal(assigned.status, 200); assert.equal((await assigned.json()).assignedNodeId, '3');
  const audit = (await pool.query('SELECT coordinator_node_id,epoch::text,reason FROM assignment_events WHERE sensor_id=$1', [probeId])).rows;
  assert.deepEqual(audit, [{ coordinator_node_id: '3', epoch: first.epoch, reason: 'MANUAL' }]);
  const denied = await post(edge('1'), `/assignments/${probeId}`);
  assert.equal(denied.status, 409);
  await assert.rejects(pool.query('UPDATE sensors SET assigned_node_id=$1 WHERE id=$2', ['2', probeId]), (e) => e.code === '42501');
  console.log('PASS follower HTTP409; direct SQL without authority SQLSTATE42501; API manual update audited by leader3:', JSON.stringify(audit));

  // Use the existing coordinator handler to create an actual transient
  // two-LEADER state; no test-only election or authorization bypass is added.
  assert.equal((await post(edge('2'), '/coordinator', { leaderId: '2' })).status, 200);
  await delay(2500);
  const roles = await Promise.all(['2','3'].map((id) => get(edge(id), '/health')));
  assert.ok(roles.every((r) => r.role === 'LEADER'));
  const still = await lease(); assert.equal(still.nodeId, '3'); assert.equal(still.epoch, first.epoch);
  assert.equal((await post(edge('2'), `/assignments/${probeId}`)).status, 409);
  await assert.rejects(forgedWrite({ ...first, nodeId: '2' }), (e) => e.code === '42501');
  await pool.query("INSERT INTO sensors(id,name,zone) VALUES($1,$1,'hcm')", [dualId]);
  assert.equal((await post(api, `/api/sensors/${dualId}/assign`)).status, 200);
  const dualAudit = (await pool.query('SELECT coordinator_node_id,epoch::text,reason FROM assignment_events WHERE sensor_id=$1', [dualId])).rows;
  assert.deepEqual(dualAudit, [{ coordinator_node_id: '3', epoch: first.epoch, reason: 'MANUAL' }]);
  console.log('PASS two actual LEADER reports; sole DB writer node3; node2 SQL rejected:', JSON.stringify({ roles, lease: still, writes: dualAudit }));
  assert.equal((await post(edge('2'), '/coordinator', { leaderId: '3' })).status, 200);

  // Hold a sensor lock before queuing an API request on the old leader. Only
  // the test sensor's zone changes, so that request would need to move it.
  blocker = await pool.connect(); await blocker.query('BEGIN');
  await blocker.query('SELECT 1 FROM sensors WHERE id=$1 FOR UPDATE', [probeId]);
  await blocker.query("UPDATE sensors SET zone='danang' WHERE id=$1", [probeId]);
  const beforeId = (await pool.query('SELECT COALESCE(MAX(id),0)::text AS n FROM assignment_events')).rows[0].n;
  const old = await lease();
  let completed = false;
  oldRequest = post(api, `/api/sensors/${probeId}/assign`).then(async (r) => { completed = true; return { status: r.status, body: await r.json() }; });
  await wait(async () => {
    const result = await pool.query(`SELECT pid,query FROM pg_stat_activity WHERE application_name='smartedge-coordinator-3'
      AND wait_event_type='Lock' AND (query LIKE 'SELECT id, zone, assigned_node_id FROM sensors%' OR query LIKE 'SELECT pg_advisory_xact_lock%')`);
    return result.rowCount > 0 && !completed;
  }, 'old leader request waiting on sensor');
  assert.equal((await post(edge('3'), '/coordinator', { leaderId: '2' })).status, 200);
  assert.equal((await post(edge('2'), '/coordinator', { leaderId: '2' })).status, 200);
  await wait(async () => { const l = await lease(); return l.valid && l.nodeId === '2' && BigInt(l.epoch) > BigInt(old.epoch); }, 'new authority2 while old work waits', 4000);
  const next = await lease();
  await blocker.query('COMMIT'); blocker.release(); blocker = undefined;
  const result = await oldRequest;
  assert.equal(result.status, 409, JSON.stringify(result));
  await assert.rejects(forgedWrite(old), (e) => e.code === '42501');
  const staleEvents = await pool.query('SELECT * FROM assignment_events WHERE id>$1 AND coordinator_node_id=$2', [beforeId, '3']);
  assert.equal(staleEvents.rowCount, 0);
  const viaNew = await post(api, `/api/sensors/${probeId}/assign`);
  assert.equal(viaNew.status, 200); assert.equal((await viaNew.json()).assignedNodeId, '2');
  const handoff = (await pool.query('SELECT coordinator_node_id,epoch::text,reason,assigned_node_id FROM assignment_events WHERE sensor_id=$1 AND id>$2', [probeId, beforeId])).rows;
  assert.ok(handoff.length > 0 && handoff.every((e) => e.coordinator_node_id === '2' && e.epoch === next.epoch && e.assigned_node_id === '2'));
  console.log('PASS actual in-flight old request HTTP409 after lease transfer; stale SQL rejected; API now routes to node2:', JSON.stringify({ old, next, response: result, handoff }));
} finally {
  if (blocker) { await blocker.query('ROLLBACK'); blocker.release(); }
  if (oldRequest) await Promise.allSettled([oldRequest]);
  try {
    await post(edge('2'), '/coordinator', { leaderId: '3' });
    await post(edge('3'), '/election/start');
    await wait(async () => {
      const c = await get(api, '/api/cluster'); const l = await lease();
      return l.valid && l.nodeId === '3' && c.summary.upNodes === 3 && c.summary.leaderId === '3' && c.nodes.every((n) => n.leaderId === '3');
    }, 'restore normal leader3', 60000);
    await pool.query('DELETE FROM sensors WHERE id=ANY($1::text[])', [[probeId, dualId]]);
    console.log('CLEANUP normal three-node cluster, authority3; removed only this run UUID sensors');
  } finally { await pool.end(); }
}
