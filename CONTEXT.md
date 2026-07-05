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

## Actual Data Flow

The implementation currently uses this flow:

1. External log producers post Kafka REST payloads to the Redpanda Pandaproxy topic `logs-ingested`.
2. `pipelines/unified.yaml` consumes `logs-ingested`, unwraps optional `value`, assigns `Trace_ID` if missing, broadcasts an `Ingested` status to Redis `ws-events`, publishes the log to `logs-normalized`, and routes `ERROR` / `CRITICAL` logs to `alerts-ingested`.
3. `workers/classifier/main.py` consumes `logs-normalized`, classifies messages, publishes tag/status events to Redis `ws-events`, and produces enriched logs to `logs-persist`.
4. `pipelines/persist.yaml` consumes `logs-persist`, broadcasts `Persisted` status, and inserts batches into ClickHouse `logrider.logs_enriched`.
5. `workers/alert/index.js` consumes `alerts-ingested`, deduplicates by application and message hash in Redis, publishes alert events to Redis `alerts-stream`, stores recent notification state in Redis, and pushes Telegram jobs to `telegram_outbound`.
6. `integrations/telegram/main.go` links Telegram chats to LogRider users and consumes `telegram_outbound`.
7. `server/index.js` serves pages, REST APIs, and WebSocket fan-out from Redis pub/sub channels.

## Important Mismatches To Keep In Mind

- There is no dedicated authenticated ingestion API in the current code. The demo scripts target Pandaproxy directly, while Compose no longer exposes Pandaproxy to the host.
- Processing status is not persisted as `Raw -> Normalized -> Stored`; UI status events are transient Redis/WebSocket messages named `Ingested`, `Persisted`, and classification-related variants.
- The live WebSocket stream currently has a backend RBAC leak because non-admin users subscribe to the global log topic.
- Alert deduplication is real Redis Lua state, but it sends notifications on first occurrence and again at thresholds 10, 50, and 100, so it does not satisfy the "100 times within 1 minute results in exactly one notification" requirement.
- The ClickHouse schema uses native types for level, timestamp, and trace IDs, but hot tables are ordered by `(Timestamp, Trace_ID)`, not by the common application/level filters.
- Configuration is only partially centralized in `.env.example`; many ports, topic names, defaults, image tags, credentials, and demo users remain hardcoded.

## Operational Entry Points

From `logrider/`:

- `docker compose up -d` starts the stack.
- `docker compose ps` checks service status.
- `scripts/setup-topics.sh` creates Redpanda topics, but it contains redundant topic creation and should be cleaned up.
- `scripts/test.sh` is intended to send 500 logs in 2 seconds, but currently depends on host access to `localhost:8082`, which Compose does not publish.
- `scripts/cleanup.sh` clears ClickHouse tables and Redis.

## Documentation State

The root `README.md` is only a repository placeholder. The application documentation is `logrider/README.md`.

The most current audit is `specs/06-evaluation/2995290a203781930f2dbfa0947411da2867e80f.md`, created against commit `2995290a203781930f2dbfa0947411da2867e80f`.
