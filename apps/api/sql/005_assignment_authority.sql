-- No existing sensor/reading/alert rows are modified by this migration.
CREATE TABLE IF NOT EXISTS assignment_authority (
  singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
  holder_node_id VARCHAR(50) REFERENCES nodes(id),
  holder_instance_id UUID,
  epoch BIGINT NOT NULL DEFAULT 0 CHECK (epoch >= 0),
  lease_until TIMESTAMPTZ NOT NULL DEFAULT '-infinity',
  CHECK ((holder_node_id IS NULL) = (holder_instance_id IS NULL))
);
INSERT INTO assignment_authority(singleton) VALUES(true) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS assignment_events (
  id BIGSERIAL PRIMARY KEY,
  sensor_id VARCHAR(50) NOT NULL,
  previous_node_id VARCHAR(50),
  assigned_node_id VARCHAR(50),
  coordinator_node_id VARCHAR(50) NOT NULL,
  coordinator_instance_id UUID NOT NULL,
  epoch BIGINT NOT NULL,
  reason TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE OR REPLACE FUNCTION require_assignment_authority() RETURNS void LANGUAGE plpgsql AS $$
DECLARE authority assignment_authority%ROWTYPE;
BEGIN
  SELECT * INTO authority FROM assignment_authority WHERE singleton=true FOR UPDATE;
  IF NOT FOUND OR authority.holder_node_id IS NULL
     OR authority.holder_node_id IS DISTINCT FROM current_setting('smartedge.coordinator_node',true)
     OR authority.holder_instance_id::text IS DISTINCT FROM current_setting('smartedge.coordinator_instance',true)
     OR authority.epoch::text IS DISTINCT FROM current_setting('smartedge.coordinator_epoch',true)
     OR authority.lease_until <= clock_timestamp() THEN
    RAISE EXCEPTION 'assignment authority expired or fencing token rejected' USING ERRCODE='42501';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION guard_sensor_assignment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous_id VARCHAR(50);
BEGIN
  IF TG_OP='UPDATE' THEN
    IF NEW.assigned_node_id IS NOT DISTINCT FROM OLD.assigned_node_id THEN RETURN NEW; END IF;
    previous_id := OLD.assigned_node_id;
  ELSIF NEW.assigned_node_id IS NULL THEN RETURN NEW;
  END IF;
  PERFORM require_assignment_authority();
  INSERT INTO assignment_events(sensor_id,previous_node_id,assigned_node_id,coordinator_node_id,
    coordinator_instance_id,epoch,reason)
  VALUES(NEW.id,previous_id,NEW.assigned_node_id,current_setting('smartedge.coordinator_node'),
    current_setting('smartedge.coordinator_instance')::uuid,current_setting('smartedge.coordinator_epoch')::bigint,
    COALESCE(NULLIF(current_setting('smartedge.assignment_reason',true),''),'MANUAL'));
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION check_assignment_at_commit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (TG_OP='INSERT' AND NEW.assigned_node_id IS NOT NULL)
     OR (TG_OP='UPDATE' AND NEW.assigned_node_id IS DISTINCT FROM OLD.assigned_node_id) THEN
    PERFORM require_assignment_authority();
  END IF;
  RETURN NULL;
END $$;

-- DROP/CREATE makes this SQL repeatable as well as migration-runner idempotent.
DROP TRIGGER IF EXISTS sensor_assignment_guard ON sensors;
CREATE TRIGGER sensor_assignment_guard BEFORE INSERT OR UPDATE OF assigned_node_id ON sensors
  FOR EACH ROW EXECUTE FUNCTION guard_sensor_assignment();
DROP TRIGGER IF EXISTS sensor_assignment_commit_guard ON sensors;
CREATE CONSTRAINT TRIGGER sensor_assignment_commit_guard AFTER INSERT OR UPDATE ON sensors
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_assignment_at_commit();
