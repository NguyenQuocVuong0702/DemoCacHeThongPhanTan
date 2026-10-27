-- Keep historical readings/alerts intact with NULL provenance.
CREATE TABLE IF NOT EXISTS telemetry_messages (
  sensor_id VARCHAR(50) NOT NULL REFERENCES sensors(id) ON DELETE CASCADE,
  message_id VARCHAR(128) NOT NULL,
  processed_by_node_id VARCHAR(50) NOT NULL REFERENCES nodes(id),
  payload_hash TEXT NOT NULL,
  sampled_at TIMESTAMPTZ NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (sensor_id, message_id)
);

ALTER TABLE sensor_readings
  ADD COLUMN IF NOT EXISTS message_id VARCHAR(128),
  ADD COLUMN IF NOT EXISTS processed_by_node_id VARCHAR(50) REFERENCES nodes(id);
ALTER TABLE alerts
  ADD COLUMN IF NOT EXISTS message_id VARCHAR(128),
  ADD COLUMN IF NOT EXISTS processed_by_node_id VARCHAR(50) REFERENCES nodes(id);
ALTER TABLE sensor_readings ADD CONSTRAINT sensor_readings_message_fk
  FOREIGN KEY (sensor_id, message_id) REFERENCES telemetry_messages(sensor_id, message_id);
ALTER TABLE alerts ADD CONSTRAINT alerts_message_fk
  FOREIGN KEY (sensor_id, message_id) REFERENCES telemetry_messages(sensor_id, message_id);
CREATE UNIQUE INDEX IF NOT EXISTS sensor_readings_message_metric_unique
  ON sensor_readings(sensor_id, message_id, metric) WHERE message_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS alerts_message_rule_unique
  ON alerts(sensor_id, message_id, rule_id) WHERE message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS telemetry_messages_processor_time
  ON telemetry_messages(processed_by_node_id, processed_at);
CREATE INDEX IF NOT EXISTS sensor_readings_sensor_time
  ON sensor_readings(sensor_id, created_at DESC, id DESC);
