-- Per-provider-attempt telemetry. Never stores keys, prompts, questions or responses.
CREATE TABLE jev_usage_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  started_at TEXT NOT NULL
);
INSERT INTO jev_usage_meta (id, started_at) VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
CREATE TABLE jev_usage_events (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  request_id TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  key_fingerprint TEXT NOT NULL,
  http_status INTEGER,
  outcome TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  estimated_cost_nano_usd INTEGER,
  input_nano_usd_per_token INTEGER,
  output_nano_usd_per_token INTEGER,
  pricing_basis TEXT NOT NULL
);
CREATE INDEX idx_jev_usage_recent ON jev_usage_events(created_at DESC, id DESC);
CREATE INDEX idx_jev_usage_key_recent ON jev_usage_events(key_fingerprint, created_at DESC, id DESC);
-- 'all' plus one row per Asia/Shanghai day; daily rows are pruned after 90 days.
CREATE TABLE jev_usage_totals (
  period TEXT PRIMARY KEY,
  requests INTEGER NOT NULL DEFAULT 0,
  successful INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  unknown_usage_requests INTEGER NOT NULL DEFAULT 0,
  estimated_cost_nano_usd INTEGER NOT NULL DEFAULT 0,
  unknown_cost_requests INTEGER NOT NULL DEFAULT 0
);
