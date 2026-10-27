// Run against a dedicated Phase A test stack. Requires the repo's dev install.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { connect } from 'mqtt';

if (process.env.PHASE_A_TESTING !== '1') throw new Error('Set PHASE_A_TESTING=1 only for an isolated test stack');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 });
const api = process.env.API_URL || 'http://127.0.0.1:4000';
const mode = process.argv[2] || 'check';
const snapshotPath = process.argv[3];
async function request(path, method = 'GET', body) {
  const response = await fetch(`${api}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(5000) });
  assert.ok(response.ok, `${method} ${path}: ${response.status}`);
  return response.json();
}
async function waitFor(check) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) { if (await check()) return; await delay(250); }
  throw new Error('Timed out waiting for real MQTT processing');
}
async function snapshot(limit = {}) {
  const maxRead = limit.maxRead ?? (await pool.query('SELECT COALESCE(MAX(id),0) AS n FROM sensor_readings')).rows[0].n;
  const maxAlert = limit.maxAlert ?? (await pool.query('SELECT COALESCE(MAX(id),0) AS n FROM alerts')).rows[0].n;
  const maxTime = limit.maxTime ?? (await pool.query('SELECT clock_timestamp() AS t')).rows[0].t.toISOString();
  const hash = async (table, where, params = []) => (await pool.query(`SELECT COUNT(*)::int AS count, md5(string_agg(row_to_json(r)::text,'' ORDER BY row_to_json(r)::text)) AS hash FROM ${table} r ${where}`, params)).rows[0];
  return { maxRead, maxAlert, maxTime,
    readings: await hash('sensor_readings', 'WHERE id <= $1', [maxRead]),
    alerts: await hash('alerts', 'WHERE id <= $1', [maxAlert]),
    rules: await hash('alert_rules', ''), sensors: await hash('sensors', ''),
    receipts: await hash('telemetry_messages', 'WHERE processed_at <= $1', [maxTime]),
  };
}

try {
  if (mode === 'snapshot') {
    assert.ok(snapshotPath);
    const saved = await snapshot(); await writeFile(snapshotPath, JSON.stringify(saved, null, 2));
    console.log('PASS snapshot saved:', JSON.stringify(saved));
  } else if (mode === 'verify') {
    const saved = JSON.parse(await readFile(snapshotPath, 'utf8'));
    const current = await snapshot(saved); assert.deepEqual(current, saved);
    console.log('PASS restart retained all readings, alerts, rules, sensors/assignments and receipts:', JSON.stringify(current));
  } else {
    const inventory = JSON.parse(await readFile(new URL('../config/demo-sensors.json', import.meta.url), 'utf8'));
    const sensors = (await request('/api/sensors')).sensors;
    for (const expected of inventory) {
      const sensor = sensors.find((s) => s.id === expected.id);
      assert.ok(sensor); assert.equal(sensor.zone, expected.zone);
      assert.equal(sensor.assignedNodeId, String(Math.floor((Number(expected.id) - 1) / 2) + 1));
      assert.equal(sensor.assignmentStrategy, 'SAME_ZONE');
      assert.equal((await request(`/api/sensors/${sensor.id}/readings?limit=2`)).readings.length, 2);
    }
    const proof = (await pool.query('SELECT sensor_id,processed_by_node_id,COUNT(*)::int AS samples FROM telemetry_messages GROUP BY sensor_id,processed_by_node_id ORDER BY sensor_id,processed_by_node_id')).rows;
    assert.deepEqual([...new Set(proof.map((r) => r.processed_by_node_id))].sort(), ['1', '2', '3']);
    console.log('PASS real simulator processing on all 3 nodes:', JSON.stringify(proof));

    const run = randomUUID();
    const rule = await request('/api/alert-rules', 'POST', { name: `Phase A MQTT proof ${run}`, metric: 'temperature', operator: '>', threshold: 90, severity: 'INFO', enabled: true });
    const client = connect(process.env.MQTT_URL || 'mqtt://127.0.0.1:1883');
    await new Promise((resolve, reject) => { client.once('connect', resolve); client.once('error', reject); });
    const samples = inventory.map((s) => ({ messageId: `phase-a-${run}-${s.id}`, sensorId: s.id, sensorName: s.name, zone: s.zone, temperature: 91, humidity: 40, timestamp: new Date().toISOString() }));
    try {
      for (let n = 0; n < 20; n++) for (const sample of samples) {
        await new Promise((resolve, reject) => client.publish(`sensors/${sample.sensorId}/telemetry`, JSON.stringify(sample), { qos: 1 }, (error) => error ? reject(error) : resolve()));
      }
      await waitFor(async () => Number((await pool.query('SELECT COUNT(*) AS n FROM telemetry_messages WHERE message_id=ANY($1::text[])', [samples.map((s) => s.messageId)])).rows[0].n) === 6);
      const evidence = [];
      for (const sample of samples) {
        const row = (await pool.query(`SELECT m.sensor_id,m.processed_by_node_id,
          (SELECT COUNT(*)::int FROM sensor_readings r WHERE r.sensor_id=m.sensor_id AND r.message_id=m.message_id) AS readings,
          (SELECT COUNT(*)::int FROM alerts a WHERE a.sensor_id=m.sensor_id AND a.message_id=m.message_id AND a.rule_id=$2) AS alerts
          FROM telemetry_messages m WHERE m.message_id=$1`, [sample.messageId, rule.id])).rows;
        assert.equal(row.length, 1); assert.equal(row[0].readings, 2); assert.equal(row[0].alerts, 1);
        assert.equal(row[0].processed_by_node_id, String(Math.floor((Number(sample.sensorId) - 1) / 2) + 1));
        evidence.push(row[0]);
      }
      console.log('PASS 20 MQTT deliveries/sample: 1 receipt, 2 readings, 1 alert/rule:', JSON.stringify(evidence));
      // A disabled rule must not create alerts, even though readings still commit.
      await request(`/api/alert-rules/${rule.id}`, 'PATCH', { enabled: false });
      const disabled = { ...samples[0], messageId: `phase-a-disabled-${run}` };
      await new Promise((resolve, reject) => client.publish('sensors/1/telemetry', JSON.stringify(disabled), { qos: 1 }, (error) => error ? reject(error) : resolve()));
      await waitFor(async () => (await pool.query('SELECT 1 FROM telemetry_messages WHERE message_id=$1', [disabled.messageId])).rowCount === 1);
      assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM alerts WHERE message_id=$1 AND rule_id=$2', [disabled.messageId, rule.id])).rows[0].n, 0);
      const disposable = await request('/api/alert-rules', 'POST', { name: `Phase A CRUD ${run}`, metric: 'humidity', operator: '>', threshold: 999, severity: 'WARNING', enabled: false });
      assert.equal((await request(`/api/alert-rules/${disposable.id}`, 'DELETE')).deleted, true);
      console.log('PASS alert rule create/update/disable/delete through existing API; evidence rule retained disabled');
      const alerts = (await request('/api/alerts?limit=500')).alerts.filter((a) => a.ruleId === rule.id);
      assert.equal(new Set(alerts.map((a) => a.sensorId)).size, 6);
      console.log('PASS /api/alerts exposes alerts from all 6 sensors');
    } finally { await new Promise((resolve) => client.end(false, {}, resolve)); }
  }
} finally { await pool.end(); }
