import { DashboardOutlined, PlusOutlined } from "@ant-design/icons";
import {
  Alert,
  Button,
  Card,
  Col,
  Form,
  Input,
  InputNumber,
  message,
  Modal,
  Popconfirm,
  Row,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
} from "antd";
import type { TableProps } from "antd";
import { useEffect, useState } from "react";

import {
  createAlertRule,
  deleteAlertRule,
  fetchAlertRules,
  updateAlertRule,
} from "../api/smartedge";
import type { AlertRule, AlertRuleInput } from "../types";

const metricOptions = [
  { value: "temperature", label: "temperature" },
  { value: "humidity", label: "humidity" },
];

const operatorOptions = [">", ">=", "<", "<=", "=", "=="].map(
  (operator) => ({ value: operator, label: operator }),
);

const severityOptions = ["INFO", "WARNING", "CRITICAL"].map(
  (severity) => ({ value: severity, label: severity }),
);

function severityColor(severity: AlertRule["severity"]): string {
  if (severity === "CRITICAL") return "red";
  if (severity === "WARNING") return "gold";
  return "blue";
}

export function AlertRulesPanel() {
  const [form] = Form.useForm<AlertRuleInput>();
  const [messageApi, messageHolder] = message.useMessage();
  const [rules, setRules] = useState<AlertRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingRule, setEditingRule] = useState<AlertRule | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [busyRuleId, setBusyRuleId] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    void fetchAlertRules()
      .then((data) => {
        if (active) {
          setRules(data);
          setLoadError(null);
        }
      })
      .catch(() => {
        if (active) {
          setLoadError("Unable to load alert rules.");
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, []);

  async function refreshRules(): Promise<void> {
    try {
      setRules(await fetchAlertRules());
      setLoadError(null);
    } catch {
      setLoadError("Unable to refresh alert rules.");
      messageApi.error("Unable to refresh alert rules");
    }
  }

  function closeModal(): void {
    if (submitting) return;
    setModalOpen(false);
    setEditingRule(null);
    form.resetFields();
  }

  function openCreate(): void {
    setEditingRule(null);
    form.resetFields();
    form.setFieldsValue({ enabled: true });
    setModalOpen(true);
  }

  function openEdit(rule: AlertRule): void {
    setEditingRule(rule);
    form.setFieldsValue({
      name: rule.name,
      metric: rule.metric,
      operator: rule.operator,
      threshold: rule.threshold,
      severity: rule.severity,
      enabled: rule.enabled,
    });
    setModalOpen(true);
  }

  async function saveRule(values: AlertRuleInput): Promise<void> {
    setSubmitting(true);
    try {
      const savedRule = editingRule
        ? await updateAlertRule(editingRule.id, values)
        : await createAlertRule(values);

      setRules((current) =>
        editingRule
          ? current.map((rule) => (rule.id === savedRule.id ? savedRule : rule))
          : [...current, savedRule],
      );

      setModalOpen(false);
      setEditingRule(null);
      form.resetFields();
      messageApi.success(editingRule ? "Rule updated" : "Rule created");
      await refreshRules();
    } catch {
      messageApi.error(editingRule ? "Unable to update rule" : "Unable to create rule");
    } finally {
      setSubmitting(false);
    }
  }

  async function removeRule(rule: AlertRule): Promise<void> {
    setBusyRuleId(rule.id);
    try {
      await deleteAlertRule(rule.id);
      setRules((current) => current.filter((item) => item.id !== rule.id));
      messageApi.success("Rule deleted");
      await refreshRules();
    } catch {
      messageApi.error("Unable to delete rule");
    } finally {
      setBusyRuleId(null);
    }
  }

  async function toggleRule(rule: AlertRule, enabled: boolean): Promise<void> {
    setBusyRuleId(rule.id);
    try {
      const updatedRule = await updateAlertRule(rule.id, { enabled });
      setRules((current) =>
        current.map((item) => (item.id === rule.id ? updatedRule : item)),
      );
      await refreshRules();
    } catch {
      messageApi.error("Unable to change rule status");
      await refreshRules();
    } finally {
      setBusyRuleId(null);
    }
  }

  const columns: TableProps<AlertRule>["columns"] = [
    { title: "Name", dataIndex: "name", key: "name" },
    {
      title: "Metric",
      dataIndex: "metric",
      key: "metric",
      render: (value: string) => <Tag>{value}</Tag>,
    },
    { title: "Operator", dataIndex: "operator", key: "operator" },
    { title: "Threshold", dataIndex: "threshold", key: "threshold" },
    {
      title: "Severity",
      dataIndex: "severity",
      key: "severity",
      render: (value: AlertRule["severity"]) => (
        <Tag color={severityColor(value)}>{value}</Tag>
      ),
    },
    {
      title: "Enabled",
      dataIndex: "enabled",
      key: "enabled",
      render: (_value: boolean, rule: AlertRule) => (
        <Switch
          aria-label={`Enable ${rule.name}`}
          checked={rule.enabled}
          loading={busyRuleId === rule.id}
          disabled={busyRuleId !== null}
          onChange={(checked) => void toggleRule(rule, checked)}
        />
      ),
    },
    {
      title: "Actions",
      key: "actions",
      render: (_value: unknown, rule: AlertRule) => (
        <Space size="small" className="rule-actions">
          <Button
            type="link"
            size="small"
            disabled={busyRuleId !== null}
            onClick={() => openEdit(rule)}
          >
            Edit
          </Button>
          <Popconfirm
            title={`Delete ${rule.name}?`}
            description="Related alerts will also be deleted."
            okText="Delete"
            okButtonProps={{ danger: true }}
            onConfirm={() => void removeRule(rule)}
          >
            <Button type="link" danger size="small" disabled={busyRuleId !== null}>
              Delete
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <Card className="panel-card table-panel">
      {messageHolder}
      <div className="section-heading section-heading--inside">
        <div>
          <span className="section-eyebrow">Configuration</span>
          <Typography.Title level={2}>Alert Rules</Typography.Title>
        </div>
        <div className="rule-heading-actions">
          <DashboardOutlined className="section-icon" />
          <Button
            type="primary"
            icon={<PlusOutlined />}
            disabled={loading}
            onClick={openCreate}
          >
            New Rule
          </Button>
        </div>
      </div>

      {loadError && (
        <Alert className="inline-error" type="error" showIcon message={loadError} />
      )}

      <Table<AlertRule>
        rowKey="id"
        columns={columns}
        dataSource={rules}
        loading={loading}
        pagination={false}
        size="middle"
        scroll={{ x: 720 }}
        locale={{ emptyText: "No alert rules found" }}
      />

      <Modal
        title={editingRule ? "Edit Alert Rule" : "New Alert Rule"}
        open={modalOpen}
        onCancel={closeModal}
        onOk={() => form.submit()}
        okText={editingRule ? "Save Changes" : "Create Rule"}
        okButtonProps={{ loading: submitting }}
        cancelButtonProps={{ disabled: submitting }}
        closable={!submitting}
        maskClosable={!submitting}
        forceRender
      >
        <Form<AlertRuleInput>
          form={form}
          layout="vertical"
          onFinish={(values) => void saveRule(values)}
        >
          <Form.Item
            label="Name"
            name="name"
            rules={[
              { required: true, whitespace: true, message: "Enter a rule name" },
              { max: 100, message: "Name must be at most 100 characters" },
            ]}
          >
            <Input maxLength={100} placeholder="e.g. High temperature" />
          </Form.Item>

          <Row gutter={16}>
            <Col xs={24} sm={12}>
              <Form.Item
                label="Metric"
                name="metric"
                rules={[{ required: true, message: "Select a metric" }]}
              >
                <Select options={metricOptions} placeholder="Select metric" />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12}>
              <Form.Item
                label="Operator"
                name="operator"
                rules={[{ required: true, message: "Select an operator" }]}
              >
                <Select options={operatorOptions} placeholder="Select operator" />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12}>
              <Form.Item
                label="Threshold"
                name="threshold"
                rules={[
                  { required: true, message: "Enter a threshold" },
                  {
                    validator: (_, value: unknown) =>
                      value === undefined || value === null ||
                      (typeof value === "number" && Number.isFinite(value))
                        ? Promise.resolve()
                        : Promise.reject(new Error("Enter a finite number")),
                  },
                ]}
              >
                <InputNumber style={{ width: "100%" }} placeholder="Threshold" />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12}>
              <Form.Item
                label="Severity"
                name="severity"
                rules={[{ required: true, message: "Select a severity" }]}
              >
                <Select options={severityOptions} placeholder="Select severity" />
              </Form.Item>
            </Col>
          </Row>

          <Form.Item label="Enabled" name="enabled" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
