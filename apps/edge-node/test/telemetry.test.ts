import assert from "node:assert/strict";
import test from "node:test";
import { parseTelemetry, telemetryHash } from "../src/telemetry.js";
import { evaluateValue } from "../src/event-matcher.js";

const input = { sensorId: "1", sensorName: "sensor-1", temperature: 33, humidity: 70, timestamp: "2026-10-27T00:00:00Z" };

test("original sensor-1 payloads get stable IDs, including equivalent timestamps", () => {
  const first = parseTelemetry(input, "sensors/1/telemetry");
  assert.match(first.messageId, /^legacy:[a-f0-9]{64}$/);
  assert.equal(first.messageId, parseTelemetry({ ...input, timestamp: "2026-10-27T07:00:00+07:00" }).messageId);
  assert.notEqual(first.messageId, parseTelemetry({ ...input, temperature: 34 }).messageId);
});

test("publisher message ID is retained; payload fingerprints detect conflicting reuse", () => {
  const sample = parseTelemetry({ ...input, messageId: "sample-1" });
  assert.equal(sample.messageId, "sample-1");
  assert.notEqual(telemetryHash(sample), telemetryHash({ ...sample, humidity: 99 }));
});

test("invalid payloads and topic mismatches are rejected before persistence", () => {
  for (const value of [null, [], {}, { ...input, sensorId: "x/y" }, { ...input, sensorName: " " },
    { ...input, temperature: NaN }, { ...input, humidity: Infinity }, { ...input, timestamp: "bad" },
    { ...input, messageId: null }, { ...input, messageId: "" }, { ...input, messageId: "x".repeat(129) }]) {
    assert.throws(() => parseTelemetry(value));
  }
  assert.throws(() => parseTelemetry(input, "sensors/2/telemetry"), /Topic/);
});

test("event matching operators retain their original behavior", () => {
  for (const [operator, yes, no] of [[">", 33, 32], [">=", 32, 31], ["<", 31, 32],
    ["<=", 32, 33], ["=", 32, 33], ["==", 32, 31]] as const) {
    assert.equal(evaluateValue(yes, operator, 32), true);
    assert.equal(evaluateValue(no, operator, 32), false);
  }
  assert.equal(evaluateValue(33, "invalid", 32), false);
});
