import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadSensors } from "../src/sensors.js";

test("demo catalog has six sensors split evenly over the three zones", async () => {
  const sensors = await loadSensors({ SENSORS_FILE: fileURLToPath(new URL("../../../config/demo-sensors.json", import.meta.url)) });
  assert.deepEqual(sensors.map((s) => s.id), ["1", "2", "3", "4", "5", "6"]);
  assert.deepEqual(sensors.map((s) => s.zone), ["hanoi", "hanoi", "danang", "danang", "hcm", "hcm"]);
});

test("legacy SENSOR_ID/SENSOR_NAME still select a single sensor", async () => {
  assert.deepEqual(await loadSensors({ SENSOR_ID: "1", SENSOR_NAME: "sensor-1" }), [{ id: "1", name: "sensor-1", zone: "hanoi" }]);
  await assert.rejects(loadSensors({}), /required/);
  await assert.rejects(loadSensors({ SENSOR_ID: "bad/topic" }), /Invalid/);
});
