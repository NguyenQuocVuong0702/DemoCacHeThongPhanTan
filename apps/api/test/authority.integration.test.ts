import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import {
  acquireOrRenewLease, releaseLease, setAuthorityContext, createAssignmentService,
  AuthorityLostError, type AssignmentAuthority, type LeaseToken, type ClusterNodeStatus,
  createPostgresStream,
} from "@smartedge/coordination";

const url = process.env.ASSIGNMENT_TEST_DATABASE_URL;
test("PostgreSQL authority: competing leaders, fencing, expiration, in-flight work and disconnect", { skip: !url }, async (t) => {
  assert.match(new URL(url!).pathname, /^\/phase_b_test/);
  const schema = `authority_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: url });
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.end();
  const scoped = new URL(url!);
  scoped.searchParams.set("options", `-c search_path=${schema},public`);
  const pool = new Pool({ connectionString: scoped.href, application_name: schema, stream: createPostgresStream });
  pool.on("error", () => {}); // The disconnect test intentionally kills a connection.
  pool.on("connect", (client) => { client.on("error", () => {}); });
  const instance3 = randomUUID();
  const instance2 = randomUUID();
  const two: ClusterNodeStatus[] = [{ id: "2", name: "edge-2", url: "http://unused", status: "UP", role: "LEADER", leaderId: "2" }];
  const service = createAssignmentService(pool, async () => two);
  const authority = (token: LeaseToken, check: () => void = () => {}): AssignmentAuthority => ({ ...token, assertCurrent: check });
  const fenced = (error: unknown) => (error as { code?: string }).code === "42501" || error instanceof AuthorityLostError;
  const events = async () => Number((await pool.query("SELECT COUNT(*) AS n FROM assignment_events")).rows[0].n);
  const owner = async () => (await pool.query("SELECT assigned_node_id FROM sensors WHERE id='1'")).rows[0].assigned_node_id;
  async function claim(id: string, instance: string, ttl = 30000) {
    const token = await acquireOrRenewLease(pool, id, instance, ttl);
    assert.ok(token); return token;
  }
  async function write(token: LeaseToken, target: string) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN"); await setAuthorityContext(client, token);
      await client.query("UPDATE sensors SET assigned_node_id=$1 WHERE id='1'", [target]);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; } finally { client.release(); }
  }
  async function blocked(prefix: string) {
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const rows = await pool.query("SELECT pid FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock' AND ltrim(query) LIKE $2", [schema, `${prefix}%`]);
      if (rows.rowCount) return Number(rows.rows[0].pid);
      await delay(10);
    }
    throw new Error(`Expected blocked real SQL: ${prefix}`);
  }
  try {
    for (const name of ["001_initial_schema.sql", "002_add_location_fields.sql", "003_seed_edge_locations.sql", "004_distributed_telemetry.sql", "005_assignment_authority.sql"]) {
      await pool.query(await readFile(new URL(`../sql/${name}`, import.meta.url), "utf8"));
    }
    // Running migration SQL again preserves singleton epoch and existing data.
    await pool.query(await readFile(new URL("../sql/005_assignment_authority.sql", import.meta.url), "utf8"));
    await pool.query("INSERT INTO sensors(id,name,zone) VALUES('1','authority-test','hcm')");

    await t.test("two simultaneous LEADER claims grant exactly one process, including duplicate node IDs", async () => {
      const contenders = await Promise.all([
        acquireOrRenewLease(pool, "3", instance3), acquireOrRenewLease(pool, "2", instance2),
      ]);
      assert.equal(contenders.filter(Boolean).length, 1);
      const winner = contenders.find(Boolean)!;
      assert.equal(await acquireOrRenewLease(pool, winner.nodeId, randomUUID()), undefined);
      const renewed = await acquireOrRenewLease(pool, winner.nodeId, winner.instanceId);
      assert.equal(renewed?.epoch, winner.epoch);
      await releaseLease(pool, winner);
    });
    await t.test("missing/forged process or epoch cannot update; committed audit carries the true authority", async () => {
      const token = await claim("3", instance3);
      const before = await events();
      await assert.rejects(pool.query("UPDATE sensors SET assigned_node_id='2' WHERE id='1'"), fenced);
      await assert.rejects(write({ ...token, instanceId: instance2 }, "2"), fenced);
      await assert.rejects(write({ ...token, epoch: String(BigInt(token.epoch) - 1n) }, "2"), fenced);
      assert.equal(await events(), before); assert.equal(await owner(), null);
      await write(token, "3");
      const event = (await pool.query("SELECT coordinator_node_id,epoch::text,assigned_node_id FROM assignment_events ORDER BY id DESC LIMIT 1")).rows[0];
      assert.deepEqual(event, { coordinator_node_id: "3", epoch: token.epoch, assigned_node_id: "3" });
      await releaseLease(pool, token);
    });
    await t.test("an expired lease cannot renew the old epoch; deferred COMMIT check rolls back both sensor and audit", async () => {
      const token = await claim("3", instance3, 400);
      const before = await events();
      const client = await pool.connect();
      try {
        await client.query("BEGIN"); await setAuthorityContext(client, token);
        await client.query("UPDATE sensors SET assigned_node_id='2' WHERE id='1'");
        await client.query("SELECT pg_sleep(0.5)");
        await assert.rejects(client.query("COMMIT"), fenced);
      } finally { await client.query("ROLLBACK"); client.release(); }
      assert.equal(await owner(), "3"); assert.equal(await events(), before);
      const next = await claim("3", instance3);
      assert.ok(BigInt(next.epoch) > BigInt(token.epoch));
      await assert.rejects(write(token, "2"), fenced);
      await releaseLease(pool, next);
    });
    await t.test("takeover while old leader waits on a sensor fences the queued old transaction", async () => {
      const old = await claim("3", instance3);
      const before = await events();
      const blocker = await pool.connect();
      let task: Promise<unknown> | undefined;
      try {
        await blocker.query("BEGIN"); await blocker.query("SELECT 1 FROM sensors WHERE id='1' FOR UPDATE");
        task = service.assignSensor("1", authority(old));
        const rejected = assert.rejects(task, fenced);
        await blocked("SELECT id, zone, assigned_node_id FROM sensors");
        await releaseLease(pool, old);
        const next = await claim("2", instance2);
        await blocker.query("COMMIT"); await rejected;
        assert.equal(await owner(), "3"); assert.equal(await events(), before);
        await assert.rejects(write(old, "1"), fenced);
        await write(next, "2");
        await releaseLease(pool, next);
      } finally { await blocker.query("ROLLBACK"); blocker.release(); if (task) await Promise.allSettled([task]); }
    });
    await t.test("losing local leadership after UPDATE rolls back the entire in-flight decision", async () => {
      const token = await claim("3", instance3);
      await write(token, "3"); const before = await events();
      let current = true;
      const blocker = await pool.connect();
      let task: Promise<unknown> | undefined;
      try {
        await blocker.query("BEGIN"); await blocker.query("LOCK TABLE assignment_events IN ACCESS EXCLUSIVE MODE");
        task = service.assignSensor("1", authority(token, () => { if (!current) throw new AuthorityLostError(); }));
        const rejected = assert.rejects(task, fenced);
        await blocked("UPDATE sensors SET assigned_node_id");
        current = false;
        await blocker.query("COMMIT"); await rejected;
        assert.equal(await owner(), "3"); assert.equal(await events(), before);
      } finally { await blocker.query("ROLLBACK"); blocker.release(); if (task) await Promise.allSettled([task]); }
      await releaseLease(pool, token);
    });
    await t.test("DB connection loss aborts a queued assignment; a later epoch safely proceeds", async () => {
      const old = await claim("3", instance3);
      const before = await events(); const blocker = await pool.connect();
      let task: Promise<unknown> | undefined;
      try {
        await blocker.query("BEGIN"); await blocker.query("SELECT 1 FROM sensors WHERE id='1' FOR UPDATE");
        task = service.assignSensor("1", authority(old));
        const rejected = assert.rejects(task, /terminat|connection|closed/i);
        const pid = await blocked("SELECT id, zone, assigned_node_id FROM sensors");
        await pool.query("SELECT pg_terminate_backend($1)", [pid]);
        await rejected; await blocker.query("COMMIT");
        assert.equal(await owner(), "3"); assert.equal(await events(), before);
        await releaseLease(pool, old); const next = await claim("2", instance2);
        await write(next, "2"); await releaseLease(pool, next);
      } finally { await blocker.query("ROLLBACK"); blocker.release(); if (task) await Promise.allSettled([task]); }
    });
  } finally { await pool.end(); }
});
