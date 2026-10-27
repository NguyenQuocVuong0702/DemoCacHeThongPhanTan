import type { PoolClient } from "pg";
import type { SensorTelemetry } from "./telemetry.js";

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
  client: PoolClient,
  telemetry: SensorTelemetry,
  processorNodeId: string,
): Promise<number> {
  const result = await client.query<AlertRule>(
    `SELECT id, name, metric, operator, threshold, severity, enabled
     FROM alert_rules
     WHERE enabled = true
     FOR KEY SHARE`,
  );
  let alertsCreated = 0;
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

    await client.query(
      `INSERT INTO alerts
         (sensor_id, rule_id, metric, value, status, created_at, message_id, processed_by_node_id)
       VALUES ($1, $2, $3, $4, 'OPEN', $5, $6, $7)`,
      [
        telemetry.sensorId,
        rule.id,
        rule.metric,
        value,
        telemetry.timestamp,
        telemetry.messageId,
        processorNodeId,
      ],
    );

    alertsCreated++;
  }
  return alertsCreated;
}
