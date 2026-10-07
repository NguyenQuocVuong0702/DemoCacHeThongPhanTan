import { Router } from "express";

import {
  createAlertRule,
  deleteAlertRule,
  getAlertRules,
  getAlerts,
  updateAlertRule,
} from "../controllers/alerts-controller.js";
import {
  getSensorReadings,
  getSensors,
} from "../controllers/sensors-controller.js";
import { getCluster } from "../controllers/cluster-controller.js";
import { getNodes } from "../controllers/nodes-controller.js";
import { assignSensorToNode } from "../controllers/assignment-controller.js";

export const apiRouter = Router();

apiRouter.get("/sensors", getSensors);
apiRouter.get("/sensors/:id/readings", getSensorReadings);
apiRouter.post("/sensors/:id/assign", assignSensorToNode);
apiRouter.get("/alerts", getAlerts);
apiRouter.get("/alert-rules", getAlertRules);
apiRouter.post("/alert-rules", createAlertRule);
apiRouter.patch("/alert-rules/:id", updateAlertRule);
apiRouter.delete("/alert-rules/:id", deleteAlertRule);
apiRouter.get("/cluster", getCluster);
apiRouter.get("/nodes", getNodes);
