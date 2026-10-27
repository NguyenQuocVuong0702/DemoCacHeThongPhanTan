import { Socket } from "node:net";
import { createNetworkLookup } from "./healthProbe.js";

// node-postgres calls stream.connect(port, hostname) (or a Unix socket path).
// Override only that TCP lookup; pg retains the original hostname for TLS SNI
// and certificate validation. Fresh DB connections must not queue behind the
// heartbeat/election's OS DNS requests for stopped Docker peer names.
export function createPostgresStream(): Socket {
  const socket = new Socket();
  const connect = socket.connect.bind(socket);
  const { lookup, cancel } = createNetworkLookup();
  socket.connect = ((portOrPath: number | string, hostname?: string) => {
    if (typeof portOrPath === "string") return connect(portOrPath);
    return connect({ port: portOrPath, host: hostname || "localhost", lookup });
  }) as Socket["connect"];
  socket.once("close", cancel);
  return socket;
}
