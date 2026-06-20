# Functional Requirements

## FR-001: Telemetry Ingestion
**Pre-condition:** Producer is authenticated via JWT.
**Trigger:** POST request to `/api/v1/logs`.
**Expected Outcome:** Payload flattened and written to `logs-raw`.
**Post-condition:** Implicit status becomes "Raw".
**Error Handling:** Drops payload > 64KB (413), depth > 5 (400).

## FR-002: Log Scrubbing and Normalization
**Pre-condition:** `logs-raw` contains messages.
**Trigger:** Rust worker pulls batch.
**Expected Outcome:** PII scrubbed, schema validated. Valid messages pushed to `logs-normalized`.
**Post-condition:** Implicit status becomes "Normalized".
**Error Handling:** Poison pills pushed to `logs-dlq`.

## FR-003: Alert Duplication
**Pre-condition:** Log level is ERROR or CRITICAL.
**Trigger:** Log normalized by Rust worker.
**Expected Outcome:** Log cloned into `alerts-priority-stream`.
**Post-condition:** Alert is queued for consumer.
**Error Handling:** Fails gracefully (logged) if Redpanda topic is full.

## FR-004: Alert Deduplication
**Pre-condition:** Messages in `alerts-priority-stream`.
**Trigger:** Alert consumer reads message.
**Expected Outcome:** 100 identical fingerprints in 60s trigger 1 Telegram notification.
**Post-condition:** Counter reset or window rolls over.
**Error Handling:** Redis offline -> Fails closed (no alerts sent) or batch fallback.

## FR-005: Live Stream Fan-Out
**Pre-condition:** User connected via WebSocket.
**Trigger:** Message arrives in `logs-normalized`.
**Expected Outcome:** Server filters message against user's `app_grants` and sends via socket.
**Post-condition:** Message delivered.
**Error Handling:** Disconnects user on write timeout.

## FR-006: AI Classification
**Pre-condition:** AI Sidecar online.
**Trigger:** Message arrives in `logs-normalized`.
**Expected Outcome:** Tags generated and written to `log_ai_tags` ClickHouse table and `ai-tags-stream`.
**Post-condition:** Tags available for analytics.
**Error Handling:** Skips processing on AI model timeout.
