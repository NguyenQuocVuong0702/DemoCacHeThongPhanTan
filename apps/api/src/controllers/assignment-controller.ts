import type { Request, Response } from "express";

import { assignSensor } from "../services/assignmentService.js";

export async function assignSensorToNode(
  request: Request,
  response: Response,
): Promise<void> {
  const sensorIdParam = request.params.id;
  const sensorId = Array.isArray(sensorIdParam)
    ? sensorIdParam[0]
    : sensorIdParam;

  if (!sensorId) {
    response.status(404).json({ error: "Sensor not found" });
    return;
  }

  try {
    const result = await assignSensor(sensorId);

    if (!result.ok) {
      const statusCode = result.reason === "SENSOR_NOT_FOUND" ? 404 : 409;
      response.status(statusCode).json({ error: result.message });
      return;
    }

    response.status(200).json(result.assignment);
  } catch (error) {
    console.error(`Failed to assign sensor ${sensorId}:`, error);
    response.status(500).json({ error: "Internal server error" });
  }
}
