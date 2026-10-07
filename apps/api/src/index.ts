import "dotenv/config";

import cors from "cors";
import express from "express";
import type { ErrorRequestHandler } from "express";

import { pool } from "./db.js";
import { apiRouter } from "./routes/api.js";
import { startAssignmentMonitor } from "./services/assignmentMonitor.js";

const app = express();
const port = Number(process.env.PORT) || 4000;

const handleInvalidJson: ErrorRequestHandler = (error, _request, response, next) => {
  if (error instanceof SyntaxError && "body" in error) {
    response.status(400).json({ error: "Invalid JSON body" });
    return;
  }

  next(error);
};

app.use(cors());
app.use(express.json());
app.use(handleInvalidJson);
app.use("/api", apiRouter);

app.get("/health", (_request, response) => {
  response.json({
    status: "ok",
    service: "smartedge-api",
  });
});

app.get("/health/db", async (_request, response) => {
  try {
    const result = await pool.query<{ current_time: Date }>(
      "SELECT NOW() AS current_time",
    );

    response.json({
      status: "ok",
      database: "connected",
      currentTime: result.rows[0].current_time,
    });
  } catch (error) {
    console.error("Database health check failed:", error);

    response.status(500).json({
      status: "error",
      database: "disconnected",
    });
  }
});

app.listen(port, () => {
  console.log(`SmartEdge API is running on port ${port}`);
  startAssignmentMonitor();
});
