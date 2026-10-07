import type { Request, Response } from "express";

import { pool } from "../db.js";

type RuleFields = {
  name: string;
  metric: "temperature" | "humidity";
  operator: ">" | ">=" | "<" | "<=" | "=" | "==";
  threshold: number;
  severity: "INFO" | "WARNING" | "CRITICAL";
  enabled: boolean;
};

type RuleChanges = Partial<RuleFields>;

type ValidationResult =
  | { ok: true; values: RuleChanges }
  | { ok: false; error: string };

const ruleFields = [
  "name",
  "metric",
  "operator",
  "threshold",
  "severity",
  "enabled",
] as const;

const ruleColumns = `id, name, metric, operator, threshold, severity,
  enabled, created_at AS "createdAt"`;

function validateRuleBody(body: unknown, partial: boolean): ValidationResult {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, error: "Request body must be an object" };
  }

  const input = body as Record<string, unknown>;
  const keys = Object.keys(input);

  if (keys.length === 0) {
    return { ok: false, error: "Request body must not be empty" };
  }

  const unknownField = keys.find(
    (key) => !ruleFields.some((field) => field === key),
  );
  if (unknownField) {
    return { ok: false, error: `Unknown field: ${unknownField}` };
  }

  if (!partial) {
    const missingField = ruleFields.find(
      (field) => field !== "enabled" && !Object.hasOwn(input, field),
    );
    if (missingField) {
      return { ok: false, error: `${missingField} is required` };
    }
  }

  const values: RuleChanges = {};

  if (Object.hasOwn(input, "name")) {
    if (typeof input.name !== "string" || !input.name.trim()) {
      return { ok: false, error: "name must be a non-empty string" };
    }
    if (input.name.trim().length > 100) {
      return { ok: false, error: "name must be at most 100 characters" };
    }
    values.name = input.name.trim();
  }

  if (Object.hasOwn(input, "metric")) {
    if (input.metric !== "temperature" && input.metric !== "humidity") {
      return { ok: false, error: "metric must be temperature or humidity" };
    }
    values.metric = input.metric;
  }

  if (Object.hasOwn(input, "operator")) {
    if (
      input.operator !== ">" &&
      input.operator !== ">=" &&
      input.operator !== "<" &&
      input.operator !== "<=" &&
      input.operator !== "=" &&
      input.operator !== "=="
    ) {
      return { ok: false, error: "operator is not supported" };
    }
    values.operator = input.operator;
  }

  if (Object.hasOwn(input, "threshold")) {
    if (typeof input.threshold !== "number" || !Number.isFinite(input.threshold)) {
      return { ok: false, error: "threshold must be a finite number" };
    }
    values.threshold = input.threshold;
  }

  if (Object.hasOwn(input, "severity")) {
    if (
      input.severity !== "INFO" &&
      input.severity !== "WARNING" &&
      input.severity !== "CRITICAL"
    ) {
      return { ok: false, error: "severity must be INFO, WARNING or CRITICAL" };
    }
    values.severity = input.severity;
  }

  if (Object.hasOwn(input, "enabled")) {
    if (typeof input.enabled !== "boolean") {
      return { ok: false, error: "enabled must be a boolean" };
    }
    values.enabled = input.enabled;
  }

  return { ok: true, values };
}

function parseRuleId(param: string | string[] | undefined): string | null {
  const id = Array.isArray(param) ? param[0] : param;
  if (!id || !/^[1-9]\d*$/.test(id)) {
    return null;
  }

  try {
    return BigInt(id) <= 9223372036854775807n ? id : null;
  } catch {
    return null;
  }
}

function parseLimit(value: unknown): number {
  if (typeof value !== "string") {
    return 50;
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    return 50;
  }

  return Math.min(parsed, 500);
}

export async function getAlerts(
  request: Request,
  response: Response,
): Promise<void> {
  const status =
    typeof request.query.status === "string" && request.query.status.length > 0
      ? request.query.status
      : null;
  const limit = parseLimit(request.query.limit);

  try {
    const result = await pool.query(
      `SELECT
         a.id,
         a.sensor_id AS "sensorId",
         a.rule_id AS "ruleId",
         r.name AS "ruleName",
         a.metric,
         a.value,
         a.status,
         r.severity,
         a.created_at AS "createdAt"
       FROM alerts a
       INNER JOIN alert_rules r ON r.id = a.rule_id
       WHERE ($1::varchar IS NULL OR a.status = $1)
       ORDER BY a.created_at DESC, a.id DESC
       LIMIT $2`,
      [status, limit],
    );

    response.json({ alerts: result.rows });
  } catch (error) {
    console.error("Failed to get alerts:", error);
    response.status(500).json({ error: "Internal server error" });
  }
}

export async function getAlertRules(
  _request: Request,
  response: Response,
): Promise<void> {
  try {
    const result = await pool.query(
      `SELECT
         id,
         name,
         metric,
         operator,
         threshold,
         severity,
         enabled,
         created_at AS "createdAt"
       FROM alert_rules
       ORDER BY id ASC`,
    );

    response.json({ alertRules: result.rows });
  } catch (error) {
    console.error("Failed to get alert rules:", error);
    response.status(500).json({ error: "Internal server error" });
  }
}

export async function createAlertRule(
  request: Request,
  response: Response,
): Promise<void> {
  const validation = validateRuleBody(request.body, false);
  if (!validation.ok) {
    response.status(400).json({ error: validation.error });
    return;
  }

  const { name, metric, operator, threshold, severity, enabled = true } =
    validation.values;

  try {
    const result = await pool.query(
      `INSERT INTO alert_rules (name, metric, operator, threshold, severity, enabled)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING ${ruleColumns}`,
      [name, metric, operator, threshold, severity, enabled],
    );

    response.status(201).json(result.rows[0]);
  } catch (error) {
    console.error("Failed to create alert rule:", error);
    response.status(500).json({ error: "Internal server error" });
  }
}

export async function updateAlertRule(
  request: Request,
  response: Response,
): Promise<void> {
  const id = parseRuleId(request.params.id);
  if (!id) {
    response.status(400).json({ error: "Invalid alert rule id" });
    return;
  }

  const validation = validateRuleBody(request.body, true);
  if (!validation.ok) {
    response.status(400).json({ error: validation.error });
    return;
  }

  const { name, metric, operator, threshold, severity, enabled } =
    validation.values;

  try {
    const result = await pool.query(
      `UPDATE alert_rules
       SET name = COALESCE($2, name),
           metric = COALESCE($3, metric),
           operator = COALESCE($4, operator),
           threshold = COALESCE($5, threshold),
           severity = COALESCE($6, severity),
           enabled = COALESCE($7, enabled)
       WHERE id = $1
       RETURNING ${ruleColumns}`,
      [id, name ?? null, metric ?? null, operator ?? null,
        threshold ?? null, severity ?? null, enabled ?? null],
    );

    if (result.rows.length === 0) {
      response.status(404).json({ error: "Alert rule not found" });
      return;
    }

    response.json(result.rows[0]);
  } catch (error) {
    console.error(`Failed to update alert rule ${id}:`, error);
    response.status(500).json({ error: "Internal server error" });
  }
}

export async function deleteAlertRule(
  request: Request,
  response: Response,
): Promise<void> {
  const id = parseRuleId(request.params.id);
  if (!id) {
    response.status(400).json({ error: "Invalid alert rule id" });
    return;
  }

  try {
    const result = await pool.query<{ id: string }>(
      "DELETE FROM alert_rules WHERE id = $1 RETURNING id",
      [id],
    );

    if (result.rows.length === 0) {
      response.status(404).json({ error: "Alert rule not found" });
      return;
    }

    response.json({ deleted: true, id: result.rows[0].id });
  } catch (error) {
    console.error(`Failed to delete alert rule ${id}:`, error);
    response.status(500).json({ error: "Internal server error" });
  }
}
