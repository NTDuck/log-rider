# Project Context

## Purpose

This repository contains LogRider, a log collection and application error monitoring system. The original requirement is to ingest high-volume application logs, buffer them through a message queue, normalize and persist them, alert on `ERROR` / `CRITICAL` events with Redis-backed deduplication, and provide a real-time dashboard with role-based visibility.

The implementation lives in `logrider/`. The historical planning material lives in `specs/`, but most specs are stale relative to the current code. Treat `specs/06-evaluation/` as the current audit trail and treat implementation files as the source of truth.

## Current Implementation Snapshot

The current codebase is not the Rust/Redpanda/ClickHouse actor design described by the latest hardened specs. It is a Docker Compose application built from:

- Redpanda plus Pandaproxy as the Kafka-compatible message broker.
- Benthos pipelines for routing, persistence, and tag persistence.
- ClickHouse for log and analytics storage.
- Redis for sessions, WebSocket fan-out, alert deduplication state, notification queues, and transient configuration.
- PostgreSQL for users and RBAC assignments.
- Bun web server for HTML pages, REST APIs, sessions, and WebSocket upgrades.
- Bun/Node alert worker for Redis-based deduplication and Telegram outbound queueing.
- Go Telegram bot integration.
- Python classifier worker using Hugging Face / ONNX Runtime.

Recent repo work has already corrected several operational gaps that older notes may still mention:

- `scripts/test.sh` no longer truncates ClickHouse; cleanup is a separate concern.
- `scripts/k6-load.js` and `scripts/k6-simple.js` no longer depend on remote `jslib.k6.io` imports.
- `/api/logs/recent` now merges `log_tags` rows back into historical log responses so classified tags can survive a dashboard refresh, assuming the classifier/tag pipeline is producing rows.
- The topic setup and smoke-test scripts were cleaned up to use the actual topic names and the Compose-internal Pandaproxy path.

## Actual Data Flow

The implementation currently uses this flow:

1. External producer -> ingest-worker /v1/logs or gRPC -> logs-ingested.
2. `pipelines/unified.yaml` consumes `logs-ingested`, unwraps optional `value`, assigns `Trace_ID` if missing, broadcasts an `Ingested` status to Redis `ws-events`, publishes the log to `logs-normalized`, and routes `ERROR` / `CRITICAL` logs to `alerts-ingested`.
3. `workers/classifier/main.py` consumes `logs-normalized`, classifies messages, publishes tag/status events to Redis `ws-events`, and produces tag records to `logs-classified`.
4. `pipelines/persist.yaml` consumes `logs-persist`, broadcasts `Persisted` status, and inserts batches into ClickHouse `logrider.logs_enriched`.
5. `pipelines/tags.yaml` consumes `logs-classified` and writes tag rows into ClickHouse `logrider.log_tags`.
6. `workers/alert/index.js` consumes `alerts-ingested`, deduplicates by application and message hash in Redis, updates `incident:*` state, publishes alert events to Redis `alerts-stream`, and adds to `telegram:dirty_incidents`.
7. `integrations/telegram/main.go` uses `BZPOPMIN telegram:dirty_incidents` to send/edit Telegram messages and update notification state.
8. `server/index.js` serves pages, REST APIs, config API, and WebSocket fan-out from Redis pub/sub channels.

## Important Mismatches To Keep In Mind

- Processing status is not persisted as `Raw -> Normalized -> Stored`; UI status events are transient Redis/WebSocket messages named `Ingested`, `Persisted`, and classification-related variants.
- The ClickHouse schema uses native types for level, timestamp, and trace IDs, but hot tables are ordered by `(Timestamp, Trace_ID)`, not by the common application/level filters.
- The ClickHouse schema uses native types for level, timestamp, and trace IDs, but hot tables are ordered by `(Timestamp, Trace_ID)`, not by the common application/level filters.
- Configuration is only partially centralized in `.env.example`; many ports, topic names, defaults, image tags, credentials, and demo users remain hardcoded.
- In the current runtime, the classifier/tag path still needs sceptical verification after restarts. The code is wired for `logs-normalized -> logs-classified -> log_tags`, but a fresh stack may spend significant time loading the model before any tags appear.

## Operational Entry Points

From `logrider/`:

- `docker compose up -d` starts the stack.
- `docker compose ps` checks service status.
- `scripts/setup-topics.sh` creates the currently used Redpanda topics with explicit partition counts.
- `scripts/test.sh` sends exactly 500 logs through Pandaproxy from inside the Compose network and expects exactly 500 ClickHouse rows after a prior cleanup.
- `scripts/cleanup.sh` clears ClickHouse tables and Redis.
- `scripts/verify_features.sh` smoke-tests login, metrics, log history, and Redis pub/sub events against the live stack.

## Documentation State

The root `README.md` is only a repository placeholder. The application documentation is `logrider/README.md`.

The most current audit should be the latest file in `specs/06-evaluation/`, keyed by the evaluated commit hash.
