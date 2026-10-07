INSERT INTO nodes (id, name, zone)
VALUES
  ('1', 'edge-1', 'hanoi'),
  ('2', 'edge-2', 'danang'),
  ('3', 'edge-3', 'hcm')
ON CONFLICT (id)
DO UPDATE SET
  name = EXCLUDED.name,
  zone = EXCLUDED.zone;

UPDATE sensors
SET zone = 'hanoi'
WHERE id = '1';
