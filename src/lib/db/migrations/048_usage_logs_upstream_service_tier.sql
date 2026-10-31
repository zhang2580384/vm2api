-- 047_usage_logs_upstream_service_tier — the tier the upstream echoed (#777).
--
-- service_tier keeps the tier the gateway sent and is the billing band.
-- upstream_service_tier is response.service_tier, lowercased; NULL when the
-- upstream did not echo one. Sent `priority` + echoed `default` means Codex
-- served the request at the standard tier. Historical rows stay NULL.

ALTER TABLE usage_logs ADD COLUMN upstream_service_tier TEXT;
