INSERT INTO nodes (id, name, zone)
VALUES
  ('1', 'edge-1', 'hanoi'),
  ('2', 'edge-2', 'danang'),
  ('3', 'edge-3', 'hcm')
ON CONFLICT (id)
DO UPDATE SET
  zone = COALESCE(nodes.zone, EXCLUDED.zone);

-- Sensor metadata is initialized after real telemetry arrives, and only for a
-- fresh demo database. Never overwrite existing sensor zones during migration.
