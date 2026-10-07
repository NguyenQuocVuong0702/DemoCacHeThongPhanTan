import "dotenv/config";

import { connect } from "mqtt";

const configuredSensorId = process.env.SENSOR_ID;

if (!configuredSensorId) {
  throw new Error("SENSOR_ID environment variable is required");
}

const sensorId = configuredSensorId;
const sensorName = process.env.SENSOR_NAME || `sensor-${sensorId}`;
const mqttUrl = process.env.MQTT_URL || "mqtt://127.0.0.1:1883";
const configuredInterval = Number(process.env.PUBLISH_INTERVAL_MS);
const publishIntervalMs =
  Number.isFinite(configuredInterval) && configuredInterval > 0
    ? configuredInterval
    : 3000;
const topic = `sensors/${sensorId}/telemetry`;
const client = connect(mqttUrl);

let publishTimer: NodeJS.Timeout | undefined;

function randomValue(min: number, max: number): number {
  return Math.round((min + Math.random() * (max - min)) * 10) / 10;
}

function publishTelemetry(): void {
  const temperature = randomValue(20, 35);
  const humidity = randomValue(40, 80);
  const payload = {
    sensorId,
    sensorName,
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
      `[Sensor ${sensorId}] temperature=${temperature} humidity=${humidity}`,
    );
  });
}

client.on("connect", () => {
  console.log(`Sensor ${sensorId} connected to MQTT broker`);

  if (!publishTimer) {
    publishTimer = setInterval(publishTelemetry, publishIntervalMs);
  }
});

client.on("error", (error) => {
  console.error(`[Sensor ${sensorId}] MQTT error:`, error);
});
