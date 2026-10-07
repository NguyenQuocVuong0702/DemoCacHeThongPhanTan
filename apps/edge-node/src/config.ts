import "dotenv/config";

export type Peer = {
  id: string;
  url: string;
};

function parsePeers(value: string | undefined): Peer[] {
  if (!value?.trim()) {
    return [];
  }

  return value.split(",").flatMap((entry) => {
    const separatorIndex = entry.indexOf("=");

    if (separatorIndex === -1) {
      return [];
    }

    const id = entry.slice(0, separatorIndex).trim();
    const url = entry.slice(separatorIndex + 1).trim();

    return id && url ? [{ id, url }] : [];
  });
}

const configuredNodeId = process.env.NODE_ID;

if (!configuredNodeId) {
  throw new Error("NODE_ID environment variable is required");
}

export const nodeId = configuredNodeId;
export const nodeName = process.env.NODE_NAME || `edge-${nodeId}`;
export const port = Number(process.env.PORT) || 5000;
export const peers = parsePeers(process.env.PEERS);
