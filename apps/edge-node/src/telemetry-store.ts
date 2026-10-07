import { pool } from "./db.js";
import type { SensorTelemetry } from "./mqtt.js";

export async function saveTelemetry(
  telemetry: SensorTelemetry,
): Promise<void> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(
      `INSERT INTO sensors (id, name)
       VALUES ($1, $2)
       ON CONFLICT (id)
       DO UPDATE SET name = EXCLUDED.name`,
      [telemetry.sensorId, telemetry.sensorName],
    );

    await client.query(
      `INSERT INTO sensor_readings (sensor_id, metric, value, created_at)
       VALUES
         ($1, 'temperature', $2, $4),
         ($1, 'humidity', $3, $4)`,
      [
        telemetry.sensorId,
        telemetry.temperature,
        telemetry.humidity,
        telemetry.timestamp,
      ],
    );

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
