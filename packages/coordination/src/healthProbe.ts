import { Resolver } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";

export function createNetworkLookup(timeoutMs = 1000) {
  // Stopped Docker services can leave OS getaddrinfo requests pending after an
  // HTTP abort. DNS protocol queries avoid starving the shared libuv pool, so a
  // newly recovered node can be discovered while the other names remain DOWN.
  const resolver = new Resolver({ timeout: Math.max(1, Math.floor(timeoutMs / 2)), tries: 1 });
  const lookup: LookupFunction = (hostname, options, callback) => {
    const resolve = async () => {
      if (hostname === "localhost") return { address: "127.0.0.1", family: 4 };
      try {
        const addresses = await resolver.resolve4(hostname);
        if (addresses[0]) return { address: addresses[0], family: 4 };
      } catch { /* An IPv6-only name may have no A record. */ }
      const addresses = await resolver.resolve6(hostname);
      if (!addresses[0]) throw new Error(`No address for ${hostname}`);
      return { address: addresses[0], family: 6 };
    };
    void resolve().then(
      (address) => options.all ? callback(null, [address]) : callback(null, address.address, address.family),
      (error: NodeJS.ErrnoException) => callback(error, ""),
    );
  };
  return { lookup, cancel: () => resolver.cancel() };
}

export async function readNodeHealth(baseUrl: string, expectedId: string, timeoutMs = 1000): Promise<Record<string, unknown>> {
  const { lookup, cancel } = createNetworkLookup(timeoutMs);
  return new Promise((resolve, reject) => {
    const url = new URL(`${baseUrl.replace(/\/+$/, "")}/health`);
    const request = url.protocol === "https:" ? httpsRequest : httpRequest;
    // Keep the original host (and TLS SNI/verification), use a fresh connection,
    // and bound the entire request, including DNS and the response body.
    const req = request(url, { lookup, agent: false, signal: AbortSignal.timeout(timeoutMs) }, (response) => {
      if (response.statusCode !== 200) { response.resume(); reject(new Error(`Health HTTP ${response.statusCode}`)); return; }
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        text += chunk;
        if (text.length > 8192) req.destroy(new Error("Health body too large"));
      });
      response.on("error", reject);
      response.on("end", () => {
        try {
          const body = JSON.parse(text) as Record<string, unknown>;
          if (!body || body.status !== "ok" || body.nodeId !== expectedId) throw new Error("Health node identity mismatch");
          resolve(body);
        } catch (error) { reject(error); }
      });
    });
    req.on("error", reject);
    req.on("close", cancel);
    req.end();
  });
}
