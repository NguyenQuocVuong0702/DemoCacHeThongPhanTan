import { readFile } from "node:fs/promises";

export type SimulatedSensor = { id: string; name: string; zone: string };

export async function loadSensors(env: NodeJS.ProcessEnv = process.env): Promise<SimulatedSensor[]> {
  let value: unknown;
  if (env.SENSORS_FILE) {
    value = JSON.parse(await readFile(env.SENSORS_FILE, "utf8"));
  } else {
    if (!env.SENSOR_ID) throw new Error("SENSOR_ID or SENSORS_FILE is required");
    value = [{ id: env.SENSOR_ID, name: env.SENSOR_NAME || `sensor-${env.SENSOR_ID}`, zone: env.SENSOR_ZONE || "hanoi" }];
  }
  if (!Array.isArray(value) || !value.length) throw new Error("Sensor inventory must be a non-empty array");
  const ids = new Set<string>();
  for (const sensor of value) {
    if (!sensor || typeof sensor !== "object" ||
        typeof sensor.id !== "string" || !sensor.id.trim() || sensor.id.length > 50 || /[\/+#]/.test(sensor.id) ||
        typeof sensor.name !== "string" || !sensor.name.trim() || sensor.name.length > 100 ||
        typeof sensor.zone !== "string" || !sensor.zone.trim() || sensor.zone.length > 50 || ids.has(sensor.id)) {
      throw new Error("Invalid or duplicate sensor in inventory");
    }
    ids.add(sensor.id);
  }
  return value as SimulatedSensor[];
}
