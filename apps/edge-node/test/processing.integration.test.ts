import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { parseTelemetry } from "../src/telemetry.js";

const url = process.env.TEST_DATABASE_URL;
test("PostgreSQL processing, deduplication, rollback and assignment handoff", { skip: !url }, async (t) => {
  assert.match(new URL(url!).pathname, /^\/phase_a_test/, "Use a dedicated phase_a_test* database");
  process.env.DATABASE_URL = url;
  const { pool } = await import("../src/db.js");
  const { saveTelemetry } = await import("../src/telemetry-store.js");
  const run = randomUUID().slice(0, 8);
  const sensorId = `phase-a-${run}`;
  const sample = () => parseTelemetry({
    sensorId, sensorName: sensorId, messageId: randomUUID(),
    temperature: 91, humidity: 40, timestamp: new Date().toISOString(),
  });
  async function counts(messageId: string) {
    const result = await pool.query(
      `SELECT (SELECT COUNT(*) FROM telemetry_messages WHERE sensor_id=$1 AND message_id=$2)::int AS receipts,
        (SELECT COUNT(*) FROM sensor_readings WHERE sensor_id=$1 AND message_id=$2)::int AS readings,
        (SELECT COUNT(*) FROM alerts WHERE sensor_id=$1 AND message_id=$2 AND rule_id=$3)::int AS alerts`,
      [sensorId, messageId, ruleId],
    );
    return result.rows[0];
  }
  async function waitBlocked(prefix: string) {
    const deadline = Date.now() + 2500;
    while (Date.now() < deadline) {
      const result = await pool.query(
        `SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()
         AND wait_event_type='Lock' AND state='active' AND ltrim(query) LIKE $1`, [`${prefix}%`],
      );
      if (result.rowCount) return;
      await delay(25);
    }
    throw new Error(`Expected a real blocked PostgreSQL statement: ${prefix}`);
  }
  let ruleId: string;
  try {
    // This suite is repeatable in a dedicated test database; it never drops
    // tables or deletes existing rows. Production migration history is untouched.
    const present = await pool.query("SELECT to_regclass('public.telemetry_messages') AS name");
    if (!present.rows[0].name) {
      const setup = await pool.connect();
      try {
        await setup.query("BEGIN");
        for (const file of ["001_initial_schema.sql", "002_add_location_fields.sql", "003_seed_edge_locations.sql", "004_distributed_telemetry.sql"]) {
          await setup.query(await readFile(new URL(`../../api/sql/${file}`, import.meta.url), "utf8"));
        }
        await setup.query("COMMIT");
      } finally { setup.release(); }
    }
    await pool.query("INSERT INTO sensors(id,name,zone,assigned_node_id) VALUES($1,$1,'test-zone','1')", [sensorId]);
    const rule = await pool.query("INSERT INTO alert_rules(name,metric,operator,threshold,severity) VALUES($1,'temperature','>',90,'INFO') RETURNING id", [`phase-a-${run}`]);
    ruleId = rule.rows[0].id;

    await t.test("unassigned, unknown and non-owner nodes cannot persist", async () => {
      const data = sample();
      assert.equal((await saveTelemetry(data, "2")).status, "NOT_ASSIGNED");
      await pool.query("UPDATE sensors SET assigned_node_id=NULL WHERE id=$1", [sensorId]);
      assert.equal((await saveTelemetry(data, "1")).status, "UNASSIGNED");
      assert.equal((await saveTelemetry({ ...data, sensorId: `missing-${run}` }, "1")).status, "UNKNOWN_SENSOR");
      assert.deepEqual(await counts(data.messageId), { receipts: 0, readings: 0, alerts: 0 });
      await pool.query("UPDATE sensors SET assigned_node_id='1' WHERE id=$1", [sensorId]);
    });

    await t.test("20 concurrent deliveries commit one receipt, two readings and one alert per rule", async () => {
      const data = sample();
      const results = await Promise.all(Array.from({ length: 20 }, () => saveTelemetry(data, "1")));
      assert.equal(results.filter((r) => r.status === "PROCESSED").length, 1);
      assert.equal(results.filter((r) => r.status === "DUPLICATE").length, 19);
      assert.deepEqual(await counts(data.messageId), { receipts: 1, readings: 2, alerts: 1 });
      await assert.rejects(saveTelemetry({ ...data, temperature: 99 }, "1"), /messageId conflict/);
      await assert.rejects(pool.query(
        "INSERT INTO sensor_readings(sensor_id,metric,value,message_id,processed_by_node_id) SELECT sensor_id,metric,value,message_id,processed_by_node_id FROM sensor_readings WHERE sensor_id=$1 AND message_id=$2 LIMIT 1",
        [sensorId, data.messageId],
      ), (error: unknown) => (error as { code: string }).code === "23505");
      await assert.rejects(pool.query(
        "INSERT INTO alerts(sensor_id,rule_id,metric,value,message_id,processed_by_node_id) SELECT sensor_id,rule_id,metric,value,message_id,processed_by_node_id FROM alerts WHERE sensor_id=$1 AND message_id=$2 LIMIT 1",
        [sensorId, data.messageId],
      ), (error: unknown) => (error as { code: string }).code === "23505");
    });

    await t.test("assignment committed first fences the old owner waiting on the sensor lock", async () => {
      const blocker = await pool.connect();
      const data = sample();
      let pending: ReturnType<typeof saveTelemetry> | undefined;
      try {
        await blocker.query("BEGIN");
        await blocker.query("SELECT 1 FROM sensors WHERE id=$1 FOR UPDATE", [sensorId]);
        pending = saveTelemetry(data, "1");
        await waitBlocked("SELECT assigned_node_id FROM sensors");
        await blocker.query("UPDATE sensors SET assigned_node_id='2' WHERE id=$1", [sensorId]);
        await blocker.query("COMMIT");
        assert.equal((await pending).status, "NOT_ASSIGNED");
        assert.equal((await saveTelemetry(data, "2")).status, "PROCESSED");
        assert.deepEqual(await counts(data.messageId), { receipts: 1, readings: 2, alerts: 1 });
      } finally {
        await blocker.query("ROLLBACK"); blocker.release();
        if (pending) await Promise.allSettled([pending]);
      }
    });

    await t.test("processing holds assignment until commit; replay after handoff cannot duplicate alerts", async () => {
      await pool.query("UPDATE sensors SET assigned_node_id='1' WHERE id=$1", [sensorId]);
      const blocker = await pool.connect();
      const updater = await pool.connect();
      const data = sample();
      let pending: ReturnType<typeof saveTelemetry> | undefined;
      let handoff: Promise<unknown> | undefined;
      try {
        await blocker.query("BEGIN");
        await blocker.query("LOCK TABLE alerts IN ACCESS EXCLUSIVE MODE");
        pending = saveTelemetry(data, "1");
        await waitBlocked("INSERT INTO alerts");
        handoff = updater.query("UPDATE sensors SET assigned_node_id='2' WHERE id=$1", [sensorId]);
        await waitBlocked("UPDATE sensors SET assigned_node_id");
        await blocker.query("COMMIT");
        assert.equal((await pending).status, "PROCESSED");
        await handoff;
        assert.equal((await saveTelemetry(data, "2")).status, "DUPLICATE");
        assert.deepEqual(await counts(data.messageId), { receipts: 1, readings: 2, alerts: 1 });
        const owner = await pool.query("SELECT processed_by_node_id FROM telemetry_messages WHERE sensor_id=$1 AND message_id=$2", [sensorId, data.messageId]);
        assert.equal(owner.rows[0].processed_by_node_id, "1");
      } finally {
        await blocker.query("ROLLBACK"); blocker.release();
        await Promise.allSettled([pending, handoff]); updater.release();
      }
    });

    await t.test("alert failure rolls back receipt and readings; retry can commit the whole sample", async () => {
      const blocker = await pool.connect();
      const data = sample();
      try {
        await blocker.query("BEGIN");
        await blocker.query("LOCK TABLE alerts IN ACCESS EXCLUSIVE MODE");
        await assert.rejects(saveTelemetry(data, "2"), /lock timeout/);
      } finally { await blocker.query("ROLLBACK"); blocker.release(); }
      assert.deepEqual(await counts(data.messageId), { receipts: 0, readings: 0, alerts: 0 });
      assert.equal((await saveTelemetry(data, "2")).status, "PROCESSED");
      assert.deepEqual(await counts(data.messageId), { receipts: 1, readings: 2, alerts: 1 });
    });
  } finally { await pool.end(); }
});
