import {
  Alert as AntAlert,
  Card,
  Col,
  Empty,
  Row,
  Select,
  Skeleton,
  Spin,
  Table,
  Tag,
  Typography,
} from "antd";
import type { TableProps } from "antd";
import {
  AlertOutlined,
  ClockCircleOutlined,
  CloudServerOutlined,
  ExperimentOutlined,
  FireOutlined,
  RadarChartOutlined,
} from "@ant-design/icons";
import { useEffect, useMemo, useState } from "react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import {
  fetchAlerts,
  fetchSensorReadings,
  fetchSensors,
  getClusterStatus,
} from "../api/smartedge";
import { AlertRulesPanel } from "../components/AlertRulesPanel";
import { ClusterTopology } from "../components/ClusterTopology";
import { EdgePlacement } from "../components/EdgePlacement";
import { SummaryCard } from "../components/SummaryCard";
import type {
  Alert,
  ClusterResponse,
  Sensor,
  SensorReading,
} from "../types";

type ChartPoint = {
  timestamp: string;
  temperature?: number;
  humidity?: number;
};

type ReadingsResult = {
  sensorId: string;
  readings: SensorReading[];
  error: string | null;
};

const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

const timeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

function formatDate(value: string | null): string {
  if (!value) {
    return "No readings yet";
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Unknown"
    : dateTimeFormatter.format(date);
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : timeFormatter.format(date);
}

function formatMetric(value: number | null, suffix: string): string {
  return value === null ? "—" : `${value.toFixed(1)}${suffix}`;
}

function severityColor(severity: string): string {
  switch (severity.toUpperCase()) {
    case "CRITICAL":
      return "red";
    case "WARNING":
      return "gold";
    default:
      return "blue";
  }
}

function buildChartData(readings: SensorReading[]): ChartPoint[] {
  const points = new Map<string, ChartPoint>();

  for (const reading of readings) {
    if (reading.metric !== "temperature" && reading.metric !== "humidity") {
      continue;
    }

    const point = points.get(reading.createdAt) ?? {
      timestamp: reading.createdAt,
    };

    point[reading.metric] = reading.value;
    points.set(reading.createdAt, point);
  }

  return [...points.values()].sort(
    (left, right) =>
      new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime(),
  );
}

export default function Dashboard() {
  const [sensors, setSensors] = useState<Sensor[]>([]);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [readingsResult, setReadingsResult] = useState<ReadingsResult | null>(
    null,
  );
  const [selectedSensorId, setSelectedSensorId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cluster, setCluster] = useState<ClusterResponse | null>(null);
  const [clusterLoading, setClusterLoading] = useState(true);
  const [clusterError, setClusterError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let liveRequestInFlight = false;

    async function loadDashboard() {
      liveRequestInFlight = true;

      try {
        const [sensorData, alertData] = await Promise.all([
          fetchSensors(),
          fetchAlerts(20),
        ]);

        if (!active) {
          return;
        }

        setSensors(sensorData);
        setAlerts(alertData);
        setSelectedSensorId((current) =>
          current && sensorData.some((sensor) => sensor.id === current)
            ? current
            : (sensorData[0]?.id ?? null),
        );
      } catch {
        if (active) {
          setError("Unable to load dashboard data. Check that the API is running.");
        }
      } finally {
        liveRequestInFlight = false;

        if (active) {
          setLoading(false);
        }
      }
    }

    async function refreshLiveData() {
      if (liveRequestInFlight) {
        return;
      }

      liveRequestInFlight = true;

      try {
        const [sensorData, alertData] = await Promise.all([
          fetchSensors(),
          fetchAlerts(20),
        ]);

        if (active) {
          setSensors(sensorData);
          setAlerts(alertData);
          setSelectedSensorId((current) =>
            current && sensorData.some((sensor) => sensor.id === current)
              ? current
              : (sensorData[0]?.id ?? null),
          );
        }
      } catch {
        if (active) {
          console.warn("[Dashboard] Live sensor and alert refresh failed");
        }
      } finally {
        liveRequestInFlight = false;
      }
    }

    void loadDashboard();
    const intervalId = window.setInterval(() => {
      void refreshLiveData();
    }, 3_000);

    return () => {
      active = false;
      window.clearInterval(intervalId);
    };
  }, []);

  useEffect(() => {
    let active = true;
    let requestInFlight = false;

    async function loadClusterStatus() {
      if (requestInFlight) {
        return;
      }

      requestInFlight = true;

      try {
        const data = await getClusterStatus();

        if (active) {
          setCluster(data);
          setClusterError(null);
        }
      } catch {
        if (active) {
          setClusterError(
            "The edge nodes could not be reached through the cluster API.",
          );
        }
      } finally {
        requestInFlight = false;

        if (active) {
          setClusterLoading(false);
        }
      }
    }

    void loadClusterStatus();
    const intervalId = window.setInterval(() => {
      void loadClusterStatus();
    }, 2_000);

    return () => {
      active = false;
      window.clearInterval(intervalId);
    };
  }, []);

  useEffect(() => {
    if (!selectedSensorId) {
      return;
    }

    const sensorId = selectedSensorId;
    let active = true;
    let requestInFlight = false;
    let initialRequestCompleted = false;

    async function refreshReadings() {
      if (requestInFlight) {
        return;
      }

      requestInFlight = true;

      try {
        const data = await fetchSensorReadings(sensorId, 50);

        if (active) {
          setReadingsResult({
            sensorId,
            readings: data,
            error: null,
          });
          initialRequestCompleted = true;
        }
      } catch {
        if (active) {
          if (!initialRequestCompleted) {
            setReadingsResult({
              sensorId,
              readings: [],
              error: "Unable to load telemetry for this sensor.",
            });
          } else {
            console.warn(
              `[Dashboard] Live readings refresh failed for sensor ${sensorId}`,
            );
          }

          initialRequestCompleted = true;
        }
      } finally {
        requestInFlight = false;
      }
    }

    void refreshReadings();
    const intervalId = window.setInterval(() => {
      void refreshReadings();
    }, 3_000);

    return () => {
      active = false;
      window.clearInterval(intervalId);
    };
  }, [selectedSensorId]);

  const freshestSensor = useMemo(
    () =>
      [...sensors]
        .filter((sensor) => sensor.lastSeen)
        .sort(
          (left, right) =>
            new Date(right.lastSeen ?? 0).getTime() -
            new Date(left.lastSeen ?? 0).getTime(),
        )[0],
    [sensors],
  );

  const selectedSensor = sensors.find(
    (sensor) => sensor.id === selectedSensorId,
  );
  const activeReadingsResult =
    readingsResult?.sensorId === selectedSensorId ? readingsResult : null;
  const readingsLoading =
    selectedSensorId !== null && activeReadingsResult === null;
  const readingsError = activeReadingsResult?.error ?? null;
  const chartData = useMemo(
    () => buildChartData(activeReadingsResult?.readings ?? []),
    [activeReadingsResult],
  );
  const openAlerts = alerts.filter(
    (alert) => alert.status.toUpperCase() === "OPEN",
  ).length;

  const alertColumns: TableProps<Alert>["columns"] = [
    {
      title: "Time",
      dataIndex: "createdAt",
      key: "createdAt",
      render: (value: string) => formatDate(value),
    },
    { title: "Sensor", dataIndex: "sensorId", key: "sensorId" },
    { title: "Rule", dataIndex: "ruleName", key: "ruleName" },
    {
      title: "Metric",
      dataIndex: "metric",
      key: "metric",
      render: (value: string) => <Tag>{value}</Tag>,
    },
    {
      title: "Value",
      dataIndex: "value",
      key: "value",
      render: (value: number) => value.toFixed(1),
    },
    {
      title: "Severity",
      dataIndex: "severity",
      key: "severity",
      render: (value: string) => (
        <Tag color={severityColor(value)}>{value}</Tag>
      ),
    },
    {
      title: "Status",
      dataIndex: "status",
      key: "status",
      render: (value: string) => (
        <Tag color={value.toUpperCase() === "OPEN" ? "error" : "default"}>
          {value}
        </Tag>
      ),
    },
  ];

  return (
    <main className="dashboard-shell">
      <header className="dashboard-header">
        <div className="brand-lockup">
          <div className="brand-mark">
            <RadarChartOutlined />
          </div>
          <div>
            <Typography.Title level={1}>SmartEdge Monitor</Typography.Title>
            <Typography.Text>
              Distributed IoT &amp; Edge Monitoring Platform
            </Typography.Text>
          </div>
        </div>
        <div className="header-status">
          <span className="status-dot" />
          API-backed monitoring
        </div>
      </header>

      {error && (
        <AntAlert
          className="dashboard-error"
          type="error"
          showIcon
          message="Dashboard unavailable"
          description={error}
        />
      )}

      <section className="summary-grid" aria-label="System summary">
        {loading ? (
          Array.from({ length: 4 }, (_, index) => (
            <Card key={index} className="summary-skeleton">
              <Skeleton active paragraph={{ rows: 1 }} />
            </Card>
          ))
        ) : (
          <>
            <SummaryCard
              icon={<CloudServerOutlined />}
              label="Sensors"
              value={sensors.length}
              detail="Registered devices"
              tone="cyan"
            />
            <SummaryCard
              icon={<FireOutlined />}
              label="Latest Temperature"
              value={formatMetric(
                freshestSensor?.latestTemperature ?? null,
                "°C",
              )}
              detail={freshestSensor?.name ?? "No telemetry"}
              tone="amber"
            />
            <SummaryCard
              icon={<ExperimentOutlined />}
              label="Latest Humidity"
              value={formatMetric(
                freshestSensor?.latestHumidity ?? null,
                "%",
              )}
              detail={freshestSensor?.name ?? "No telemetry"}
              tone="blue"
            />
            <SummaryCard
              icon={<AlertOutlined />}
              label="Open Alerts"
              value={openAlerts}
              detail="Within 20 most recent"
              tone="violet"
            />
          </>
        )}
      </section>

      <ClusterTopology
        data={cluster}
        loading={clusterLoading}
        error={clusterError}
      />

      <EdgePlacement sensors={sensors} loading={loading} />

      <section className="dashboard-section">
        <div className="section-heading">
          <div>
            <span className="section-eyebrow">Fleet</span>
            <Typography.Title level={2}>Sensor Overview</Typography.Title>
          </div>
          <Typography.Text>{sensors.length} connected records</Typography.Text>
        </div>

        {loading ? (
          <Card><Skeleton active /></Card>
        ) : sensors.length === 0 ? (
          <Card><Empty description="No sensors found" /></Card>
        ) : (
          <Row gutter={[16, 16]}>
            {sensors.map((sensor) => (
              <Col xs={24} sm={12} xl={8} key={sensor.id}>
                <Card
                  className={`sensor-card${
                    selectedSensorId === sensor.id ? " sensor-card--selected" : ""
                  }`}
                  onClick={() => setSelectedSensorId(sensor.id)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      setSelectedSensorId(sensor.id);
                    }
                  }}
                  role="button"
                  tabIndex={0}
                >
                  <div className="sensor-card__header">
                    <div>
                      <span className="sensor-id">Sensor {sensor.id}</span>
                      <h3>{sensor.name}</h3>
                    </div>
                    <span className="online-indicator">Active</span>
                  </div>
                  <div className="sensor-metrics">
                    <div>
                      <span>Temperature</span>
                      <strong>
                        {formatMetric(sensor.latestTemperature, "°C")}
                      </strong>
                    </div>
                    <div>
                      <span>Humidity</span>
                      <strong>{formatMetric(sensor.latestHumidity, "%")}</strong>
                    </div>
                  </div>
                  <div className="sensor-assignment">
                    <div>
                      <span>Zone</span>
                      <strong>{sensor.zone ?? "Unknown"}</strong>
                    </div>
                    <div>
                      <span>Assigned Edge</span>
                      <strong>
                        {sensor.assignedNodeName
                          ? `${sensor.assignedNodeName} · Node ${sensor.assignedNodeId}`
                          : "Unassigned"}
                      </strong>
                    </div>
                    <div>
                      <span>Edge Zone</span>
                      <strong>{sensor.assignedNodeZone ?? "Unknown"}</strong>
                    </div>
                    <div>
                      <span>Assignment Strategy</span>
                      <Tag
                        color={
                          sensor.assignmentStrategy === "SAME_ZONE"
                            ? "success"
                            : sensor.assignmentStrategy === "FALLBACK"
                              ? "warning"
                              : undefined
                        }
                      >
                        {sensor.assignmentStrategy ?? "UNASSIGNED"}
                      </Tag>
                    </div>
                  </div>
                  <div className="sensor-last-seen">
                    <ClockCircleOutlined />
                    Last seen {formatDate(sensor.lastSeen)}
                  </div>
                </Card>
              </Col>
            ))}
          </Row>
        )}
      </section>

      <section className="dashboard-section">
        <Card className="panel-card">
          <div className="section-heading section-heading--inside">
            <div>
              <span className="section-eyebrow">Telemetry</span>
              <Typography.Title level={2}>Sensor Signal</Typography.Title>
              <Typography.Text>
                {selectedSensor
                  ? `Latest 50 readings from ${selectedSensor.name}`
                  : "Select a sensor to inspect readings"}
              </Typography.Text>
            </div>
            <div className="telemetry-actions">
              <span className="live-polling-indicator">
                <span className="live-polling-indicator__dot" />
                Live polling · 3s
              </span>
              <Select
                aria-label="Select sensor"
                className="sensor-select"
                value={selectedSensorId ?? undefined}
                placeholder="Select sensor"
                onChange={setSelectedSensorId}
                options={sensors.map((sensor) => ({
                  value: sensor.id,
                  label: `${sensor.name} · ${sensor.id}`,
                }))}
              />
            </div>
          </div>

          {readingsError && (
            <AntAlert
              className="inline-error"
              type="error"
              showIcon
              message={readingsError}
            />
          )}

          <div className="chart-container">
            {readingsLoading ? (
              <Spin size="large" />
            ) : chartData.length === 0 ? (
              <Empty description="No telemetry readings available" />
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart
                  data={chartData}
                  margin={{ top: 16, right: 8, left: -12, bottom: 0 }}
                >
                  <CartesianGrid
                    strokeDasharray="4 4"
                    stroke="#24324a"
                    vertical={false}
                  />
                  <XAxis
                    dataKey="timestamp"
                    tickFormatter={formatTime}
                    stroke="#7890ad"
                    tickLine={false}
                    axisLine={false}
                    minTickGap={32}
                  />
                  <YAxis
                    yAxisId="temperature"
                    stroke="#7890ad"
                    tickLine={false}
                    axisLine={false}
                    width={42}
                  />
                  <YAxis
                    yAxisId="humidity"
                    orientation="right"
                    stroke="#7890ad"
                    tickLine={false}
                    axisLine={false}
                    width={42}
                  />
                  <Tooltip
                    labelFormatter={(value) => formatDate(String(value))}
                    contentStyle={{
                      background: "#111b2d",
                      border: "1px solid #2a3b56",
                      borderRadius: 10,
                    }}
                  />
                  <Legend />
                  <Line
                    yAxisId="temperature"
                    type="monotone"
                    dataKey="temperature"
                    name="Temperature (°C)"
                    stroke="#f5a524"
                    strokeWidth={2.5}
                    dot={false}
                    connectNulls
                  />
                  <Line
                    yAxisId="humidity"
                    type="monotone"
                    dataKey="humidity"
                    name="Humidity (%)"
                    stroke="#4ecdc4"
                    strokeWidth={2.5}
                    dot={false}
                    connectNulls
                  />
                </LineChart>
              </ResponsiveContainer>
            )}
          </div>
        </Card>
      </section>

      <Row gutter={[20, 20]} className="table-grid">
        <Col xs={24} xl={14}>
          <Card className="panel-card table-panel">
            <div className="section-heading section-heading--inside">
              <div>
                <span className="section-eyebrow">Events</span>
                <Typography.Title level={2}>Recent Alerts</Typography.Title>
              </div>
              <div className="table-heading-actions">
                <span className="live-polling-indicator">
                  <span className="live-polling-indicator__dot" />
                  Live polling · 3s
                </span>
                <AlertOutlined className="section-icon" />
              </div>
            </div>
            <Table<Alert>
              rowKey="id"
              columns={alertColumns}
              dataSource={alerts}
              loading={loading}
              pagination={false}
              size="middle"
              scroll={{ x: 820 }}
              locale={{ emptyText: "No alerts found" }}
            />
          </Card>
        </Col>
        <Col xs={24} xl={10}>
          <AlertRulesPanel />
        </Col>
      </Row>
    </main>
  );
}
