import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { readNodeHealth } from "../src/services/healthProbe.js";

test("health probe validates identity and handles HTTP/body failures with a deadline", async (t) => {
  let mode = "ok";
  const server = createServer((_request, response) => {
    if (mode === "hang") return;
    if (mode === "http") { response.writeHead(503).end(); return; }
    if (mode === "json") { response.end("invalid"); return; }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ status: "ok", nodeId: mode === "wrong" ? "3" : "2", role: "LEADER", leaderId: "2" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const url = `http://localhost:${address.port}`;
  try {
    await t.test("live node, correct identity", async () => assert.equal((await readNodeHealth(url, "2")).leaderId, "2"));
    await t.test("wrong node identity is never UP", async () => { mode = "wrong"; await assert.rejects(readNodeHealth(url, "2"), /identity/); });
    await t.test("HTTP failure", async () => { mode = "http"; await assert.rejects(readNodeHealth(url, "2"), /503/); });
    await t.test("invalid JSON", async () => { mode = "json"; await assert.rejects(readNodeHealth(url, "2")); });
    await t.test("hanging response is aborted", async () => { mode = "hang"; await assert.rejects(readNodeHealth(url, "2", 100), /abort/i); });
    await t.test("node recovers after failed probes", async () => { mode = "ok"; assert.equal((await readNodeHealth(url, "2")).nodeId, "2"); });
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});
