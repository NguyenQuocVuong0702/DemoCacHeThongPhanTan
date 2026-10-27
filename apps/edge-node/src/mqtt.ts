import "dotenv/config";

import { connect, type MqttClient } from "mqtt";

import { nodeId } from "./config.js";
import { saveTelemetry } from "./telemetry-store.js";
import { parseTelemetry, type SensorTelemetry } from "./telemetry.js";
export type { SensorTelemetry } from "./telemetry.js";

const MQTT_TOPIC = "sensors/+/telemetry";
const mqttUrl = process.env.MQTT_URL || "mqtt://127.0.0.1:1883";

let mqttClient: MqttClient | undefined;

async function persistAndEvaluateTelemetry(
  telemetry: SensorTelemetry,
): Promise<void> {
  try {
    const result = await saveTelemetry(telemetry, nodeId);
    if (result.status === "PROCESSED") {
      console.log(`[Telemetry][Node ${nodeId}] committed sensor=${telemetry.sensorId} message=${telemetry.messageId} alerts=${result.alertsCreated}`);
    } else if (result.status === "DUPLICATE") {
      console.log(`[Telemetry][Node ${nodeId}] duplicate sensor=${telemetry.sensorId} message=${telemetry.messageId}`);
    } else if (result.status !== "NOT_ASSIGNED") {
      console.warn(`[Telemetry][Node ${nodeId}] skipped sensor=${telemetry.sensorId}: ${result.status}`);
    }
  } catch (error) {
    console.error(
      `[Telemetry][Node ${nodeId}] failed sensor=${telemetry.sensorId} message=${telemetry.messageId}:`,
      error,
    );
  }
}

export function startMqttSubscriber(): void {
  if (mqttClient) {
    return;
  }

  mqttClient = connect(mqttUrl);

  mqttClient.on("connect", () => {
    mqttClient?.subscribe(MQTT_TOPIC, { qos: 0 }, (error) => {
      if (error) {
        console.error("[MQTT] Failed to subscribe to telemetry:", error);
      }
    });
  });

  mqttClient.on("message", (topic, message) => {
    let telemetry: SensorTelemetry;

    try {
      telemetry = parseTelemetry(JSON.parse(message.toString()), topic);
    } catch (error) {
      console.warn(`[MQTT] Invalid telemetry on ${topic}:`, error);
      return;
    }

    void persistAndEvaluateTelemetry(telemetry);
  });

  mqttClient.on("error", (error) => {
    console.error("[MQTT] Connection error:", error);
  });
}
