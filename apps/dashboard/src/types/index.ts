export type Sensor = {
  id: string;
  name: string;
  zone: string | null;
  assignedNodeId: string | null;
  assignedNodeName: string | null;
  assignedNodeZone: string | null;
  assignmentStrategy: "SAME_ZONE" | "FALLBACK" | null;
  createdAt: string;
  latestTemperature: number | null;
  latestHumidity: number | null;
  lastSeen: string | null;
};

export type SensorReading = {
  id: string;
  sensorId: string;
  metric: string;
  value: number;
  createdAt: string;
};

export type Alert = {
  id: string;
  sensorId: string;
  ruleId: string;
  ruleName: string;
  metric: string;
  value: number;
  severity: string;
  status: string;
  createdAt: string;
};

export type AlertRule = {
  id: string;
  name: string;
  metric: "temperature" | "humidity";
  operator: ">" | ">=" | "<" | "<=" | "=" | "==";
  threshold: number;
  severity: "INFO" | "WARNING" | "CRITICAL";
  enabled: boolean;
  createdAt: string;
};

export type AlertRuleInput = Omit<AlertRule, "id" | "createdAt">;

export type ClusterNode = {
  id: string;
  name: string;
  url: string;
  status: "UP" | "DOWN";
  role: "FOLLOWER" | "CANDIDATE" | "LEADER" | "UNKNOWN";
  leaderId: string | null;
};

export type ClusterSummary = {
  leaderId: string | null;
  upNodes: number;
  downNodes: number;
};

export type ClusterResponse = {
  nodes: ClusterNode[];
  summary: ClusterSummary;
};
