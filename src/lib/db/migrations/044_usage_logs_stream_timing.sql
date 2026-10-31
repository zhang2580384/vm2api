-- Historical rows have no observed upstream window; never reconstruct it from TTFT.
ALTER TABLE usage_logs ADD COLUMN first_byte_ms INTEGER;
ALTER TABLE usage_logs ADD COLUMN generation_ms INTEGER;
