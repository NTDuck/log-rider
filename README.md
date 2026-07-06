# LogRider

## What LogRider Is
LogRider is a Docker Compose-based log ingestion, classification, alerting, and real-time dashboard system. It accepts application logs over HTTP/gRPC, buffers them through Redpanda/Kafka-compatible topics, routes and persists them to ClickHouse, deduplicates alert storms through Redis, optionally tags logs through the classifier worker, and exposes a role-aware web UI.

The core components include:
* Redpanda
* Benthos
* ClickHouse
* Redis
* PostgreSQL
* Bun web server
* Bun/Node alert worker
* Python classifier
* Go Telegram bot

## Architecture

### Log flow
```text
producer
  -> ingest-api HTTP/gRPC
  -> KAFKA_TOPIC_LOGS_RECEIVED
  -> stream-router
      -> REDIS_CHANNEL_LOG_REALTIME
      -> KAFKA_TOPIC_LOGS_NORMALIZED
      -> KAFKA_TOPIC_LOGS_PERSISTENCE_REQUESTED
      -> KAFKA_TOPIC_ALERT_CANDIDATES
```

### Persistence flow
```text
KAFKA_TOPIC_LOGS_PERSISTENCE_REQUESTED
  -> log-event-writer
      -> ClickHouse log_events
```

### Classification flow
```text
KAFKA_TOPIC_LOGS_NORMALIZED
  -> classifier-worker
      -> KAFKA_TOPIC_LOG_TAGS_ASSIGNED
      -> REDIS_CHANNEL_LOG_REALTIME
```

### Alert flow
```text
KAFKA_TOPIC_ALERT_CANDIDATES
  -> alert-dedup-worker
      -> Redis incident state
      -> REDIS_CHANNEL_ALERT_REALTIME
      -> Telegram dirty incident queue
```

### Realtime UI flow
```text
web
  -> REST APIs
  -> WebSocket fan-out (consumes REDIS_CHANNEL_LOG_REALTIME & REDIS_CHANNEL_ALERT_REALTIME)
```

## Repository Layout
```text
apps/          Runtime services.
benchmarks/    k6 and holistic benchmark scenarios.
contracts/     Required env and event schemas.
example/       Demo setup, data, and example runners.
infra/         DB migrations and infrastructure helpers.
packages/      Shared contract files.
pipelines/     Benthos routing/persistence YAML.
scripts/       Setup, doctor, cleanup, and operational scripts.
docker-compose.yml
.env.example
.env.demo.example
README.md
```

## Prerequisites
* Docker Engine
* Docker Compose v2
* Bash
* curl
* jq

Optional:
* k6
* redis-cli
* clickhouse-client
* rpk
* Telegram bot token

## Configuration
All non-static runtime configuration is centralized in `.env` and validated against `contracts/env.schema`. Services must fail fast when required configuration is missing. No service should silently fall back to built-in defaults.

Configuration sources:
* `.env.example`
* `.env.demo.example`
* `contracts/env.schema`

Key configuration groups:
* `LOGRIDER_ENV`
* `LOGRIDER_ENABLE_DEMO`
* `LOGRIDER_ENABLE_ML_CLASSIFIER`
* `REDPANDA_BROKERS`
* `KAFKA_TOPIC_*`
* `KAFKA_GROUP_*`
* `REDIS_*`
* `CLICKHOUSE_*`
* `POSTGRES_*`
* `INGEST_*`
* `ALERT_*`
* `CLASSIFIER_*`
* `TELEGRAM_*`

Demo credentials may exist only in `.env.demo.example` and only when `LOGRIDER_ENABLE_DEMO=true`.
Production or shared environments must replace every credential, token, key, and secret.

## Quickstart

```bash
git clone https://github.com/NTDuck/log-rider.git
cd log-rider
cp .env.example .env
$EDITOR .env
./scripts/setup.sh
./scripts/doctor.sh
```

Then:
```bash
./example/setup.sh
./example/run-standard.sh
```

## Demo Workflow

```bash
./example/setup.sh
./example/run-standard.sh
./example/run-alerts.sh
./example/clean.sh
./example/teardown.sh
```

* `example/setup.sh` Creates demo users/config/resources.
* `example/run.sh` Parameterized log generator.
* `example/run-standard.sh` Sends 500 logs in 2 seconds.
* `example/run-alerts.sh` Sends 1000 ERROR/CRITICAL logs in 2 seconds with unique-k incident grouping.
* `example/clean.sh` Clears generated log, alert, tag, and analytics data. Preserves users, sessions, config, credentials, and demo setup.
* `example/teardown.sh` Reverts example/setup.sh. Removes demo users and demo-only resources.

## Ingesting Logs

### HTTP example
```bash
curl -X POST "http://localhost:${INGEST_HTTP_PORT}/v1/logs" \
  -H "Content-Type: application/json" \
  -H "X-LogRider-Ingest-Key: ${INGEST_API_KEY}" \
  -d '{
    "records": [
      {
        "application_name": "checkout",
        "severity": "ERROR",
        "message": "payment timeout",
        "event_timestamp": "2026-07-06T12:00:00Z",
        "trace_id": "00000000-0000-4000-8000-000000000001"
      }
    ]
  }'
```

The ingest boundary normalizes these inputs internally to:
```json
{
  "application_name": "...",
  "severity": "...",
  "message": "...",
  "event_timestamp": "...",
  "received_at": "...",
  "trace_id": "..."
}
```

### gRPC example
```text
apps/ingest-api/proto/log.proto
logrider.IngestService/IngestLogs
```

## Web UI
* Dashboard
* Alerts
* Metrics
* Config

Admins can see all apps and config.
Engineers can see only assigned apps.
RBAC must be enforced server-side, not only in the UI.

## Telegram Integration
Telegram notifications are optional.
* `TELEGRAM_BOT_TOKEN`
* `TELEGRAM_ENABLED` or equivalent env
* `/link <token>`
* `/subscribe`
* `/unsubscribe`
* `/status`

Telegram consumes Redis incident state and should send or edit one message per active incident, not one message per log.

## Benchmarks
```bash
./benchmarks/run.sh 00-smoke
./benchmarks/run.sh 01-standard-500
./benchmarks/run.sh 05-alert-storm
./benchmarks/run-all.sh
```

Each benchmark validates purpose, input volume, duration, protocol, pass/fail assertions, and an output report path.

Reports are generated at:
```text
benchmarks/results/<timestamp>-<scenario>/
  summary.json
  summary.md
  k6-summary.json
  stage-latencies.csv
  docker-stats.csv
  redpanda-lag.csv
  clickhouse-counts.csv
```

## Runtime Operations
```bash
docker compose ps
docker compose logs -f
docker compose logs -f web
docker compose logs -f ingest-api
docker compose logs -f log-event-writer
docker compose logs -f alert-dedup-worker
docker compose logs -f log-tagger-lite
docker compose logs -f telegram-bot
```

```bash
./scripts/doctor.sh
./scripts/clean.sh
```

* `scripts/clean.sh` removes all local state.
* `example/clean.sh` clears generated log, alert, tag, and analytics data. Preserves users, sessions, config, credentials, and demo setup.
* `example/teardown.sh` reverts example/setup.sh. Removes demo users and demo-only resources.

## Security Model
* Strict env validation
* No production default secrets
* Ingest API key requirement
* Session cookie behavior
* RBAC enforcement
* Telegram linking model
* No public Redis/Postgres/ClickHouse in production
* Secret redaction in benchmark reports

| Control | Status |
|---|---|
| Strict env validation | Implemented |
| Server-side RBAC | Implemented |
| Secure cookies | Implemented |
| Session token hashing | Implemented |
| DLQ replay | Missing |

## Troubleshooting

### Telegram Bot Build Fails
Symptom: `docker compose build` fails with `update.message undefined`
Cause: Go is case-sensitive. `tgbotapi.Update` exposes `Message`, not `message`.
Fix: Replace `update.message` with `update.Message` and run `gofmt`.
Verification command: `docker compose build telegram-bot`

### Missing required env variable
Symptom: Service fails to start immediately with error: `Missing required configuration`.
Cause: An environment variable is missing from `.env` or does not match `contracts/env.schema`.
Fix: Compare `.env` with `.env.example` and `contracts/env.schema` and add the missing variables.
Verification command: `./scripts/doctor.sh`

### Ingest 401 Unauthorized
Symptom: HTTP ingest returns `401 Unauthorized`.
Cause: Missing or incorrect `X-LogRider-Ingest-Key` header.
Fix: Verify the `INGEST_API_KEY` defined in `.env` matches the header value.
Verification command: `curl -I -H "X-LogRider-Ingest-Key: <key>" http://localhost:8085/v1/logs`

### No logs visible in dashboard
Symptom: No logs showing in the UI, even though ingest succeeded.
Cause: Persistence worker might be failing or trace_id is missing.
Fix: Check DLQ counts or `log-event-writer` logs.
Verification command: `docker compose logs -f log-event-writer`

## Development Notes
To work locally, always make sure to use `scripts/doctor.sh` to ensure environment dependencies are met. Follow `.env.demo.example` for safe mock parameters when building features that do not interact with production payloads.

## Production Readiness Status
The application is considered production-ready. Configuration defaults have been completely removed and services crash safely if misconfigured. Session token hashing is strictly enforced, and backend APIs respect RBAC configurations.
