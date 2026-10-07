import "dotenv/config";

import { connect, type MqttClient } from "mqtt";

import { nodeId } from "./config.js";
import { getElectionState } from "./election.js";
import { evaluateTelemetry } from "./event-matcher.js";
import { saveTelemetry } from "./telemetry-store.js";

export type SensorTelemetry = {
  sensorId: string;
  sensorName: string;
  temperature: number;
  humidity: number;
  timestamp: string;
};

const MQTT_TOPIC = "sensors/+/telemetry";
const mqttUrl = process.env.MQTT_URL || "mqtt://127.0.0.1:1883";

let mqttClient: MqttClient | undefined;

function isSensorTelemetry(value: unknown): value is SensorTelemetry {
  if (!value || typeof value !== "object") {
    return false;
  }

  const telemetry = value as Partial<SensorTelemetry>;

  return (
    typeof telemetry.sensorId === "string" &&
    telemetry.sensorId.length > 0 &&
    typeof telemetry.sensorName === "string" &&
    telemetry.sensorName.length > 0 &&
    typeof telemetry.temperature === "number" &&
    Number.isFinite(telemetry.temperature) &&
    typeof telemetry.humidity === "number" &&
    Number.isFinite(telemetry.humidity) &&
    typeof telemetry.timestamp === "string" &&
    Number.isFinite(Date.parse(telemetry.timestamp))
  );
}

async function persistAndEvaluateTelemetry(
  telemetry: SensorTelemetry,
): Promise<void> {
  try {
    await saveTelemetry(telemetry);
  } catch (error) {
    console.error(
      `[Telemetry] Failed to persist sensor ${telemetry.sensorId}:`,
      error,
    );
    return;
  }

  try {
    await evaluateTelemetry(telemetry);
  } catch (error) {
    console.error(
      `[Alert] Failed to evaluate sensor ${telemetry.sensorId}:`,
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
    if (getElectionState().role !== "LEADER") {
      return;
    }

    let payload: unknown;

    try {
      payload = JSON.parse(message.toString());
    } catch {
      console.warn(`[MQTT] Invalid telemetry payload on ${topic}`);
      return;
    }

    if (!isSensorTelemetry(payload)) {
      console.warn(`[MQTT] Invalid telemetry payload on ${topic}`);
      return;
    }

    console.log(
      `[Telemetry][Leader ${nodeId}] sensor=${payload.sensorId} temperature=${payload.temperature} humidity=${payload.humidity}`,
    );

    void persistAndEvaluateTelemetry(payload);
  });

  mqttClient.on("error", (error) => {
    console.error("[MQTT] Connection error:", error);
  });
}
