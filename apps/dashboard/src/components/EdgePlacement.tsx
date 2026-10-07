import { ArrowRightOutlined, EnvironmentOutlined } from "@ant-design/icons";
import { Card, Col, Empty, Row, Skeleton, Tag, Typography } from "antd";

import type { Sensor } from "../types";

type EdgePlacementProps = {
  sensors: Sensor[];
  loading: boolean;
};

function strategyTag(strategy: Sensor["assignmentStrategy"]) {
  const color =
    strategy === "SAME_ZONE"
      ? "success"
      : strategy === "FALLBACK"
        ? "warning"
        : undefined;

  return <Tag color={color}>{strategy ?? "UNASSIGNED"}</Tag>;
}

function edgeLabel(sensor: Sensor): string {
  if (!sensor.assignedNodeName) {
    return "Unassigned";
  }

  return `${sensor.assignedNodeName} (${sensor.assignedNodeZone ?? "Unknown"})`;
}

export function EdgePlacement({ sensors, loading }: EdgePlacementProps) {
  return (
    <section className="dashboard-section" aria-labelledby="edge-placement-title">
      <div className="section-heading">
        <div>
          <span className="section-eyebrow">Location-aware routing</span>
          <Typography.Title level={2} id="edge-placement-title">
            Edge Placement
          </Typography.Title>
        </div>
        <Typography.Text>Sensor zones and current edge assignments</Typography.Text>
      </div>

      {loading ? (
        <Card className="panel-card">
          <Skeleton active paragraph={{ rows: 2 }} />
        </Card>
      ) : sensors.length === 0 ? (
        <Card className="panel-card">
          <Empty description="No sensor placements available" />
        </Card>
      ) : (
        <Row gutter={[16, 16]}>
          {sensors.map((sensor) => (
            <Col xs={24} md={12} xl={8} key={sensor.id}>
              <Card className="placement-card" size="small">
                <div className="placement-card__header">
                  <div>
                    <span className="sensor-id">Sensor {sensor.id}</span>
                    <h3>{sensor.name}</h3>
                  </div>
                  {strategyTag(sensor.assignmentStrategy)}
                </div>
                <div className="placement-path">
                  <span>
                    <EnvironmentOutlined />
                    {sensor.zone ?? "Unknown"}
                  </span>
                  <ArrowRightOutlined className="placement-path__arrow" />
                  <strong>{edgeLabel(sensor)}</strong>
                </div>
              </Card>
            </Col>
          ))}
        </Row>
      )}
    </section>
  );
}
