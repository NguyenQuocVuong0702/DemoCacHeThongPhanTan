import type { Request, Response } from "express";

import { getClusterStatus } from "../services/clusterService.js";

export async function getCluster(
  _request: Request,
  response: Response,
): Promise<void> {
  try {
    const nodes = await getClusterStatus();
    const leaderId =
      nodes.find((node) => node.role === "LEADER")?.id ??
      nodes.find((node) => node.leaderId !== null)?.leaderId ??
      null;
    const upNodes = nodes.filter((node) => node.status === "UP").length;

    response.json({
      nodes,
      summary: {
        leaderId,
        upNodes,
        downNodes: nodes.length - upNodes,
      },
    });
  } catch (error) {
    console.error("Failed to get cluster status:", error);
    response.status(500).json({ error: "Internal server error" });
  }
}
