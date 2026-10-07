import { apiClient } from "./client";
import type {
  Alert,
  AlertRule,
  AlertRuleInput,
  ClusterResponse,
  Sensor,
  SensorReading,
} from "../types";

export async function fetchSensors(): Promise<Sensor[]> {
  const response = await apiClient.get<{ sensors: Sensor[] }>("/api/sensors");
  return response.data.sensors;
}

export async function fetchSensorReadings(
  sensorId: string,
  limit = 50,
): Promise<SensorReading[]> {
  const response = await apiClient.get<{
    sensorId: string;
    readings: SensorReading[];
  }>(`/api/sensors/${encodeURIComponent(sensorId)}/readings`, {
    params: { limit },
  });

  return response.data.readings;
}

export async function fetchAlerts(limit = 20): Promise<Alert[]> {
  const response = await apiClient.get<{ alerts: Alert[] }>("/api/alerts", {
    params: { limit },
  });

  return response.data.alerts;
}

export async function fetchAlertRules(): Promise<AlertRule[]> {
  const response = await apiClient.get<{ alertRules: AlertRule[] }>(
    "/api/alert-rules",
  );

  return response.data.alertRules;
}

export async function createAlertRule(
  input: AlertRuleInput,
): Promise<AlertRule> {
  const response = await apiClient.post<AlertRule>("/api/alert-rules", input);
  return response.data;
}

export async function updateAlertRule(
  id: string,
  changes: Partial<AlertRuleInput>,
): Promise<AlertRule> {
  const response = await apiClient.patch<AlertRule>(
    `/api/alert-rules/${encodeURIComponent(id)}`,
    changes,
  );
  return response.data;
}

export async function deleteAlertRule(id: string): Promise<void> {
  await apiClient.delete(`/api/alert-rules/${encodeURIComponent(id)}`);
}

export async function getClusterStatus(): Promise<ClusterResponse> {
  const response = await apiClient.get<ClusterResponse>("/api/cluster");
  return response.data;
}
