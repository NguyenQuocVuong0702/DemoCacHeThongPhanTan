import { pool } from "./db.js";
import type { SensorTelemetry } from "./mqtt.js";

export type AlertRule = {
  id: string;
  name: string;
  metric: string;
  operator: string;
  threshold: number;
  severity: string;
  enabled: boolean;
};

export function evaluateValue(
  value: number,
  operator: string,
  threshold: number,
): boolean {
  switch (operator) {
    case ">":
      return value > threshold;
    case ">=":
      return value >= threshold;
    case "<":
      return value < threshold;
    case "<=":
      return value <= threshold;
    case "=":
    case "==":
      return value === threshold;
    default:
      return false;
  }
}

export async function evaluateTelemetry(
  telemetry: SensorTelemetry,
): Promise<void> {
  const result = await pool.query<AlertRule>(
    `SELECT id, name, metric, operator, threshold, severity, enabled
     FROM alert_rules
     WHERE enabled = true`,
  );

  for (const rule of result.rows) {
    let value: number;

    if (rule.metric === "temperature") {
      value = telemetry.temperature;
    } else if (rule.metric === "humidity") {
      value = telemetry.humidity;
    } else {
      continue;
    }

    if (!evaluateValue(value, rule.operator, rule.threshold)) {
      continue;
    }

    await pool.query(
      `INSERT INTO alerts
         (sensor_id, rule_id, metric, value, status, created_at)
       VALUES ($1, $2, $3, $4, 'OPEN', $5)`,
      [
        telemetry.sensorId,
        rule.id,
        rule.metric,
        value,
        telemetry.timestamp,
      ],
    );

    console.log(
      `[Alert] sensor=${telemetry.sensorId} rule=${rule.name} metric=${rule.metric} value=${value}`,
    );
  }
}
