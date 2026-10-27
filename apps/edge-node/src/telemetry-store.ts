import { pool } from "./db.js";
import { evaluateTelemetry } from "./event-matcher.js";
import { telemetryHash, type SensorTelemetry } from "./telemetry.js";

type SkippedStatus = "UNKNOWN_SENSOR" | "UNASSIGNED" | "NOT_ASSIGNED" | "DUPLICATE";
export type ProcessingResult = { status: "PROCESSED"; alertsCreated: number } | { status: SkippedStatus };

export async function saveTelemetry(
  telemetry: SensorTelemetry,
  processorNodeId: string,
): Promise<ProcessingResult> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '10s'");
    // Assignment UPDATEs require the same row lock. Keep it until the sample,
    // both readings and all alerts commit to serialize processing with handoff.
    const sensor = await client.query<{ assigned_node_id: string | null }>(
      "SELECT assigned_node_id FROM sensors WHERE id = $1 FOR UPDATE",
      [telemetry.sensorId],
    );
    const owner = sensor.rows[0];
    let skipped: SkippedStatus | undefined;
    if (!owner) skipped = "UNKNOWN_SENSOR";
    else if (!owner.assigned_node_id) skipped = "UNASSIGNED";
    else if (owner.assigned_node_id !== processorNodeId) skipped = "NOT_ASSIGNED";
    if (skipped) {
      await client.query("ROLLBACK");
      return { status: skipped };
    }

    const hash = telemetryHash(telemetry);
    const receipt = await client.query(
      `INSERT INTO telemetry_messages
         (sensor_id, message_id, processed_by_node_id, payload_hash, sampled_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (sensor_id, message_id) DO NOTHING RETURNING message_id`,
      [telemetry.sensorId, telemetry.messageId, processorNodeId, hash, telemetry.timestamp],
    );
    if (!receipt.rowCount) {
      const existing = await client.query<{ payload_hash: string }>(
        "SELECT payload_hash FROM telemetry_messages WHERE sensor_id = $1 AND message_id = $2",
        [telemetry.sensorId, telemetry.messageId],
      );
      if (existing.rows[0].payload_hash !== hash) {
        throw new Error(`messageId conflict: ${telemetry.sensorId}/${telemetry.messageId} has a different payload`);
      }
      await client.query("ROLLBACK");
      return { status: "DUPLICATE" };
    }

    await client.query(
      `INSERT INTO sensor_readings (sensor_id, metric, value, created_at, message_id, processed_by_node_id)
       VALUES
         ($1, 'temperature', $2, $4, $5, $6),
         ($1, 'humidity', $3, $4, $5, $6)`,
      [
        telemetry.sensorId,
        telemetry.temperature,
        telemetry.humidity,
        telemetry.timestamp,
        telemetry.messageId,
        processorNodeId,
      ],
    );

    const alertsCreated = await evaluateTelemetry(client, telemetry, processorNodeId);
    await client.query("COMMIT");
    return { status: "PROCESSED", alertsCreated };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
