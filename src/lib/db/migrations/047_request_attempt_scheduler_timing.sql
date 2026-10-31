-- Total selection elapsed time is not queue residence. Historical splits stay NULL.
ALTER TABLE request_attempts ADD COLUMN queue_wait_ms INTEGER CHECK(queue_wait_ms >= 0);
ALTER TABLE request_attempts ADD COLUMN scheduling_ms INTEGER CHECK(scheduling_ms >= 0);
