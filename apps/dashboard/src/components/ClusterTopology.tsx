import {
  Alert,
  Badge,
  Card,
  Col,
  Empty,
  Row,
  Skeleton,
  Statistic,
  Tag,
  Typography,
} from "antd";
import {
  CheckCircleOutlined,
  CloudServerOutlined,
  CrownOutlined,
  DisconnectOutlined,
  SyncOutlined,
} from "@ant-design/icons";

import type { ClusterNode, ClusterResponse } from "../types";

type ClusterTopologyProps = {
  data: ClusterResponse | null;
  loading: boolean;
  error: string | null;
};

function roleColor(role: ClusterNode["role"]): string {
  switch (role) {
    case "LEADER":
      return "gold";
    case "CANDIDATE":
      return "processing";
    case "FOLLOWER":
      return "default";
    default:
      return "error";
  }
}

export function ClusterTopology({
  data,
  loading,
  error,
}: ClusterTopologyProps) {
  return (
    <section className="dashboard-section cluster-section">
      <div className="section-heading">
        <div>
          <span className="section-eyebrow">Distributed Control Plane</span>
          <Typography.Title level={2}>Edge Cluster</Typography.Title>
          <Typography.Text>
            Leader election, node health and failover status
          </Typography.Text>
        </div>
        <div className="cluster-refresh-label">
          <SyncOutlined spin={loading} />
          Refreshes every 2 seconds
        </div>
      </div>

      {loading && !data ? (
        <Card className="panel-card cluster-loading-card">
          <Skeleton active paragraph={{ rows: 4 }} />
        </Card>
      ) : error ? (
        <Alert
          type="error"
          showIcon
          message="Cluster status unavailable"
          description={error}
        />
      ) : !data ? (
        <Card className="panel-card">
          <Empty description="No cluster status available" />
        </Card>
      ) : (
        <Card className="panel-card cluster-panel">
          <Row gutter={[12, 12]} className="cluster-summary">
            <Col xs={24} sm={8}>
              <div className="cluster-stat cluster-stat--leader">
                <Statistic
                  title="Leader"
                  value={
                    data.summary.leaderId
                      ? `Node ${data.summary.leaderId}`
                      : "None"
                  }
                  prefix={<CrownOutlined />}
                />
              </div>
            </Col>
            <Col xs={12} sm={8}>
              <div className="cluster-stat cluster-stat--up">
                <Statistic
                  title="Nodes Up"
                  value={data.summary.upNodes}
                  prefix={<CheckCircleOutlined />}
                />
              </div>
            </Col>
            <Col xs={12} sm={8}>
              <div className="cluster-stat cluster-stat--down">
                <Statistic
                  title="Nodes Down"
                  value={data.summary.downNodes}
                  prefix={<DisconnectOutlined />}
                />
              </div>
            </Col>
          </Row>

          <div className="cluster-divider" />

          <Row gutter={[16, 16]} className="cluster-node-grid">
            {data.nodes.map((node) => {
              const isUp = node.status === "UP";
              const isLeader = node.role === "LEADER";

              return (
                <Col xs={24} md={8} key={node.id}>
                  <div
                    className={`cluster-node-card${
                      isLeader ? " cluster-node-card--leader" : ""
                    }${!isUp ? " cluster-node-card--down" : ""}`}
                  >
                    <div className="cluster-node-card__header">
                      <div className="cluster-node-icon">
                        {isLeader ? <CrownOutlined /> : <CloudServerOutlined />}
                      </div>
                      <Badge
                        status={isUp ? "success" : "error"}
                        text={isUp ? "UP" : "OFFLINE"}
                      />
                    </div>

                    <div className="cluster-node-card__identity">
                      <span>Node {node.id}</span>
                      <h3>{node.name}</h3>
                    </div>

                    <div className="cluster-node-card__details">
                      <div>
                        <span>Role</span>
                        <Tag color={roleColor(node.role)}>{node.role}</Tag>
                      </div>
                      <div>
                        <span>Leader ID</span>
                        <strong>{node.leaderId ?? "—"}</strong>
                      </div>
                    </div>
                  </div>
                </Col>
              );
            })}
          </Row>
        </Card>
      )}
    </section>
  );
}
