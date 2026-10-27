import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
assert.equal(process.env.LEADER_COORDINATION_TESTING, '1');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 3000 });
const api = process.env.API_URL || 'http://127.0.0.1:4000';
try {
  const before = (await pool.query('SELECT holder_node_id,epoch::text FROM assignment_authority')).rows[0];
  assert.equal(before.holder_node_id, '3', 'Requires normal leader3');
  const start = (await pool.query('SELECT clock_timestamp() AS t')).rows[0].t;
  const killed = (await pool.query(`SELECT pid,pg_terminate_backend(pid) AS terminated FROM pg_stat_activity
    WHERE application_name='smartedge-coordinator-3' AND datname=current_database()`)).rows;
  assert.ok(killed.length > 0 && killed.every((r) => r.terminated));
  const deadline = Date.now() + 20000;
  let recovered = false;
  while (Date.now() < deadline) {
    await delay(250);
    try {
      const response = await fetch('http://127.0.0.1:5003/assignments/authority', { signal: AbortSignal.timeout(2000) });
      if (!response.ok) continue;
      const state = await response.json();
      if (state.lease.valid && state.lease.holderNodeId === '3' && state.localEpoch === state.lease.epoch) {
        recovered = true; break;
      }
    } catch { /* DB reconnect is intentionally transient. */ }
  }
  assert.ok(recovered, 'Coordinator did not reacquire/renew after DB disconnect');
  const manual = await fetch(`${api}/api/sensors/5/assign`, { method: 'POST', signal: AbortSignal.timeout(10000) });
  assert.equal(manual.status, 200); assert.equal((await manual.json()).assignedNodeId, '3');
  await delay(3500);
  const workers = (await pool.query(`SELECT sensor_id,processed_by_node_id,COUNT(*)::int AS samples FROM telemetry_messages
    WHERE processed_at>$1 GROUP BY sensor_id,processed_by_node_id ORDER BY sensor_id,processed_by_node_id`, [start])).rows;
  for (let id = 1; id <= 6; id++) assert.ok(workers.some((r) => r.sensor_id === String(id) && r.processed_by_node_id === String(Math.floor((id-1)/2)+1) && r.samples > 0));
  console.log('PASS live PostgreSQL coordinator connection loss: old sessions terminated, authority recovered, API manual200, all six workers continued:', JSON.stringify({ before, killed, workers }));
} finally { await pool.end(); }
