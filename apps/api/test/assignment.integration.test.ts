import assert from "node:assert/strict";
import test from "node:test";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import type { ClusterNodeStatus } from "../src/services/clusterService.js";
import { acquireOrRenewLease, createAssignmentService, setAuthorityContext, type AssignmentAuthority } from "@smartedge/coordination";

const url = process.env.ASSIGNMENT_TEST_DATABASE_URL;
test("PostgreSQL least-loaded assignments and Phase A handoff safety", { skip: !url }, async (t) => {
  assert.match(new URL(url!).pathname, /^\/phase_b_test/, "Use a dedicated phase_b_test* database");
  const schema = `phase_b_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: url });
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.end();
  const scopedUrl = new URL(url!);
  scopedUrl.searchParams.set("options", `-c search_path=${schema},public`);
  process.env.DATABASE_URL = scopedUrl.href;
  const { pool } = await import("../src/db.js");
  const { pool: edgePool } = await import("../../edge-node/src/db.js");
  const { saveTelemetry } = await import("../../edge-node/src/telemetry-store.js");
  let authority: AssignmentAuthority;
  const service = createAssignmentService(pool, async () => all);
  const assignSensor = (id: string, options: { onlyIfUnassigned?: boolean; clusterStatus?: ClusterNodeStatus[] } = {}) => service.assignSensor(id, authority, options);
  const reconcileAssignments = (snapshot?: ClusterNodeStatus[]) => service.reconcileAssignments(authority, snapshot);
  async function fixture(sql: string) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await setAuthorityContext(client, authority);
      await client.query(sql);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }
  function cluster(ids: string[]): ClusterNodeStatus[] {
    const leader = [...ids].sort().at(-1) ?? null;
    return ["1", "2", "3"].map((id) => ({ id, name: `edge-${id}`, url: `http://edge-${id}`,
      status: ids.includes(id) ? "UP" : "DOWN", role: ids.includes(id) ? id === leader ? "LEADER" : "FOLLOWER" : "UNKNOWN",
      leaderId: ids.includes(id) ? leader : null }));
  }
  const all = cluster(["1", "2", "3"]);
  const two = cluster(["1", "2"]);
  const baseline = () => fixture(`UPDATE sensors SET zone=CASE WHEN id IN ('1','2') THEN 'hanoi' WHEN id IN ('3','4') THEN 'danang' ELSE 'hcm' END,
    assigned_node_id=CASE WHEN id IN ('1','2') THEN '1' WHEN id IN ('3','4') THEN '2' ELSE '3' END`);
  const owners = async () => (await pool.query("SELECT id,zone,assigned_node_id,xmin::text AS version FROM sensors ORDER BY id")).rows;
  async function blocked(prefix: string) {
    const deadline = Date.now() + 2500;
    while (Date.now() < deadline) {
      const result = await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND state='active' AND ltrim(query) LIKE $1", [`${prefix}%`]);
      if (result.rowCount) return;
      await delay(25);
    }
    throw new Error(`Expected a blocked statement: ${prefix}`);
  }
  try {
    const setup = await pool.connect();
    try {
      await setup.query("BEGIN");
      for (const name of ["001_initial_schema.sql", "002_add_location_fields.sql", "003_seed_edge_locations.sql", "004_distributed_telemetry.sql", "005_assignment_authority.sql"]) {
        await setup.query(await readFile(new URL(`../sql/${name}`, import.meta.url), "utf8"));
      }
      for (let id = 1; id <= 6; id++) await setup.query("INSERT INTO sensors(id,name) VALUES($1,$2)", [String(id), `sensor-${id}`]);
      await setup.query("COMMIT");
    } catch (error) { await setup.query("ROLLBACK"); throw error; } finally { setup.release(); }
    const token = await acquireOrRenewLease(pool, "3", randomUUID(), 60000);
    assert.ok(token);
    authority = { ...token, assertCurrent() {} };
    await baseline();

    await t.test("batch failover is balanced, recovery returns home, stable rounds do no UPDATE", async () => {
      const failed = await reconcileAssignments(two);
      assert.deepEqual(failed.changes.map((c) => [c.sensorId, c.assignedNodeId]), [["5", "1"], ["6", "2"]]);
      const before = await owners();
      assert.equal((await reconcileAssignments(two)).changes.length, 0);
      assert.deepEqual(await owners(), before);
      assert.equal((await reconcileAssignments(all)).changes.length, 2);
      assert.deepEqual((await owners()).map((s) => s.assigned_node_id), ["1", "1", "2", "2", "3", "3"]);
    });
    await t.test("no UP nodes reports unavailable without deleting recovery metadata; one UP recovers all", async () => {
      const before = await owners();
      const result = await reconcileAssignments(cluster([]));
      assert.equal(result.unavailable.length, 6); assert.equal(result.changes.length, 0);
      assert.deepEqual(await owners(), before);
      const manual = await assignSensor("5", { clusterStatus: cluster([]) });
      assert.equal(manual.ok, false);
      if (!manual.ok) assert.equal(manual.reason, "NO_AVAILABLE_EDGE_NODE");
      await reconcileAssignments(cluster(["2"]));
      assert.ok((await owners()).every((s) => s.assigned_node_id === "2"));
      await reconcileAssignments(all);
    });
    await t.test("concurrent explicit assignment calls share current database load", async () => {
      await fixture("UPDATE sensors SET zone='remote',assigned_node_id=NULL");
      const results = await Promise.all(["1","2","3","4","5","6"].map((id) => assignSensor(id, { clusterStatus: two })));
      assert.ok(results.every((r) => r.ok));
      const rows = await owners();
      assert.equal(rows.filter((s) => s.assigned_node_id === "1").length, 3);
      assert.equal(rows.filter((s) => s.assigned_node_id === "2").length, 3);
      await fixture("UPDATE sensors SET assigned_node_id='2',zone='lab' WHERE id='1'");
      const before = (await owners())[0];
      const preserved = await assignSensor("1", { onlyIfUnassigned: true, clusterStatus: all });
      assert.equal(preserved.ok && preserved.assignment.assignedNodeId, "2");
      assert.equal((await owners())[0].version, before.version);
      await fixture("UPDATE sensors SET assigned_node_id=NULL WHERE id='6'");
      await reconcileAssignments(all);
      assert.equal((await owners())[5].assigned_node_id, null);
      await baseline();
    });
    await t.test("same-zone selection uses least load instead of only the smallest ID", async () => {
      await pool.query("UPDATE nodes SET zone='hanoi' WHERE id='2'");
      await fixture("UPDATE sensors SET assigned_node_id='1' WHERE id IN ('1','2','3','4')");
      const selected = await assignSensor("5", { clusterStatus: two });
      // Sensor 5 has hcm: fallback goes to the empty node 2.
      assert.equal(selected.ok && selected.assignment.assignedNodeId, "2");
      await pool.query("UPDATE sensors SET zone='hanoi' WHERE id='6'");
      const same = await assignSensor("6", { clusterStatus: two });
      assert.equal(same.ok && same.assignment.assignedNodeId, "2");
      assert.equal(same.ok && same.assignment.strategy, "SAME_ZONE");
      await pool.query("UPDATE nodes SET zone='danang' WHERE id='2'");
      await baseline();
    });
    await t.test("monitor rechecks locked rows and preserves a concurrent valid custom placement", async () => {
      const writer = await pool.connect();
      let pending: ReturnType<typeof reconcileAssignments> | undefined;
      try {
        await writer.query("BEGIN");
        await setAuthorityContext(writer, authority);
        await writer.query("SELECT 1 FROM sensors WHERE id='1' FOR UPDATE");
        pending = reconcileAssignments(two);
        await blocked("SELECT id, zone, assigned_node_id FROM sensors");
        await writer.query("UPDATE sensors SET zone='lab',assigned_node_id='2' WHERE id='1'");
        await writer.query("COMMIT");
        const result = await pending;
        assert.ok(result.changes.every((c) => c.sensorId !== "1"));
        assert.equal((await owners())[0].zone, "lab");
        assert.equal((await owners())[0].assigned_node_id, "2");
      } finally { await writer.query("ROLLBACK"); writer.release(); if (pending) await Promise.allSettled([pending]); }
      await baseline();
    });
    await t.test("actual monitor transaction waits for processing COMMIT; replay after handoff stays idempotent", async () => {
      const rule = await pool.query("INSERT INTO alert_rules(name,metric,operator,threshold,severity) VALUES('phase-b-race','temperature','>',90,'INFO') RETURNING id");
      const data = { sensorId: "5", sensorName: "sensor-5", messageId: randomUUID(), temperature: 91, humidity: 40, timestamp: new Date().toISOString() };
      const blocker = await pool.connect();
      let processing: ReturnType<typeof saveTelemetry> | undefined;
      let moving: ReturnType<typeof reconcileAssignments> | undefined;
      try {
        await blocker.query("BEGIN");
        await blocker.query("LOCK TABLE alerts IN ACCESS EXCLUSIVE MODE");
        processing = saveTelemetry(data, "3");
        await blocked("INSERT INTO alerts");
        moving = reconcileAssignments(two);
        await blocked("SELECT id, zone, assigned_node_id FROM sensors");
        await blocker.query("COMMIT");
        assert.equal((await processing).status, "PROCESSED");
        await moving;
        assert.equal((await saveTelemetry(data, "1")).status, "DUPLICATE");
        const next = { ...data, messageId: randomUUID() };
        assert.equal((await saveTelemetry(next, "1")).status, "PROCESSED");
        await reconcileAssignments(all);
        assert.equal((await saveTelemetry(next, "3")).status, "DUPLICATE");
        const proof = await pool.query(`SELECT m.message_id,m.processed_by_node_id,
          (SELECT COUNT(*)::int FROM sensor_readings r WHERE r.sensor_id=m.sensor_id AND r.message_id=m.message_id) AS readings,
          (SELECT COUNT(*)::int FROM alerts a WHERE a.sensor_id=m.sensor_id AND a.message_id=m.message_id AND a.rule_id=$2) AS alerts
          FROM telemetry_messages m WHERE m.message_id=ANY($1::text[])`, [[data.messageId, next.messageId], rule.rows[0].id]);
        assert.equal(proof.rows.length, 2);
        assert.ok(proof.rows.every((r) => r.readings === 2 && r.alerts === 1));
        assert.deepEqual(proof.rows.map((r) => r.processed_by_node_id).sort(), ["1", "3"]);
      } finally { await blocker.query("ROLLBACK"); blocker.release(); await Promise.allSettled([processing, moving]); }
    });
  } finally { await Promise.all([pool.end(), edgePool.end()]); }
});
