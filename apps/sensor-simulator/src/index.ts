import "dotenv/config";

import { connect } from "mqtt";
import { randomUUID } from "node:crypto";
import { loadSensors, type SimulatedSensor } from "./sensors.js";

const sensors = await loadSensors();
const mqttUrl = process.env.MQTT_URL || "mqtt://127.0.0.1:1883";
const configuredInterval = Number(process.env.PUBLISH_INTERVAL_MS);
const publishIntervalMs =
  Number.isFinite(configuredInterval) && configuredInterval > 0
    ? configuredInterval
    : 3000;
const client = connect(mqttUrl);

let publishTimer: NodeJS.Timeout | undefined;

function randomValue(min: number, max: number): number {
  return Math.round((min + Math.random() * (max - min)) * 10) / 10;
}

function publishTelemetry(sensor: SimulatedSensor): void {
  const { id: sensorId, name: sensorName, zone } = sensor;
  const topic = `sensors/${sensorId}/telemetry`;
  const temperature = randomValue(20, 35);
  const humidity = randomValue(40, 80);
  const payload = {
    messageId: randomUUID(),
    sensorId,
    sensorName,
    zone,
    temperature,
    humidity,
    timestamp: new Date().toISOString(),
  };

  client.publish(topic, JSON.stringify(payload), { qos: 0 }, (error) => {
    if (error) {
      console.error(`[Sensor ${sensorId}] MQTT publish failed:`, error);
      return;
    }

    console.log(
      `[Sensor ${sensorId}] message=${payload.messageId} zone=${zone} temperature=${temperature} humidity=${humidity}`,
    );
  });
}

client.on("connect", () => {
  console.log(`Simulator connected to MQTT broker (${sensors.length} sensors)`);

  if (!publishTimer) {
    publishTimer = setInterval(() => sensors.forEach(publishTelemetry), publishIntervalMs);
  }
});

client.on("error", (error) => {
  console.error("[Simulator] MQTT error:", error);
});
