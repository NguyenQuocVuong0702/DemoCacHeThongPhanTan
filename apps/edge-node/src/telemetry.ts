import { createHash } from "node:crypto";

export type SensorTelemetry = {
  messageId: string;
  sensorId: string;
  sensorName: string;
  temperature: number;
  humidity: number;
  timestamp: string;
};

export function telemetryHash(telemetry: Omit<SensorTelemetry, "messageId">): string {
  return createHash("sha256").update(JSON.stringify([
    telemetry.sensorId, new Date(telemetry.timestamp).toISOString(),
    telemetry.temperature, telemetry.humidity,
  ])).digest("hex");
}

export function parseTelemetry(value: unknown, topic?: string): SensorTelemetry {
  if (!value || typeof value !== "object") throw new Error("Telemetry must be an object");
  const input = value as Record<string, unknown>;
  if (typeof input.sensorId !== "string" || !input.sensorId.trim() ||
      input.sensorId.length > 50 || /[\/+#]/.test(input.sensorId)) throw new Error("Invalid sensorId");
  if (typeof input.sensorName !== "string" || !input.sensorName.trim() || input.sensorName.length > 100) {
    throw new Error("Invalid sensorName");
  }
  if (typeof input.temperature !== "number" || !Number.isFinite(input.temperature) ||
      typeof input.humidity !== "number" || !Number.isFinite(input.humidity)) {
    throw new Error("Temperature and humidity must be finite numbers");
  }
  if (typeof input.timestamp !== "string" || !Number.isFinite(Date.parse(input.timestamp))) throw new Error("Invalid timestamp");
  if (topic !== undefined && topic !== `sensors/${input.sensorId}/telemetry`) throw new Error("Topic does not match sensorId");
  const telemetry = {
    sensorId: input.sensorId, sensorName: input.sensorName,
    temperature: input.temperature, humidity: input.humidity,
    timestamp: new Date(input.timestamp).toISOString(),
  };
  // Original sensor-1 payloads have no ID. Canonical sample content gives them
  // a deterministic key across redelivery, including equivalent timestamps.
  const messageId = input.messageId === undefined ? `legacy:${telemetryHash(telemetry)}` : input.messageId;
  if (typeof messageId !== "string" || !/^[a-zA-Z0-9:._-]{1,128}$/.test(messageId)) {
    throw new Error("Invalid messageId (expected 1-128 safe characters)");
  }
  return { ...telemetry, messageId };
}
