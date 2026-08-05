ALTER TABLE outbox_events
  ADD COLUMN IF NOT EXISTS processing_started_at timestamptz;

CREATE INDEX IF NOT EXISTS outbox_processing_lease
  ON outbox_events (status, processing_started_at)
  WHERE status = 'PROCESSING';
