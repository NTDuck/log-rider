# LogRider

LogRider is a Docker Compose demo of a log ingestion, classification, alerting, and real-time dashboard pipeline.

It currently uses Redpanda/Pandaproxy for message buffering, Benthos for routing and ClickHouse inserts, Redis for sessions/pubsub/deduplication/notification queues, PostgreSQL for users, a Bun web server, a Bun alert worker, a Go Telegram bot, and a Python classifier worker.

This README describes the implementation in this directory. Some older specs in `../specs` describe a different Rust-based architecture and should not be treated as current implementation documentation.

## Architecture

```text
Log producer
  -> Redpanda Pandaproxy topic logs-ingested
  -> Benthos unified pipeline
      -> Redis ws-events for live "Ingested" events
      -> Kafka logs-normalized
      -> Kafka logs-persist
      -> Kafka alerts-ingested for ERROR / CRITICAL logs
  -> Python classifier
      -> Redis ws-events for classification events
      -> Kafka logs-classified
  -> Benthos tags pipeline
      -> ClickHouse logrider.log_tags
  -> Benthos persist pipeline
      -> Redis ws-events for "Persisted" events
      -> ClickHouse logrider.logs_enriched
  -> Historical log API
      -> ClickHouse logrider.logs_enriched + logrider.log_tags merge

alerts-ingested
  -> Bun alert worker
      -> Redis deduplication keys
      -> Redis alerts-stream for WebSocket alerts
      -> Redis telegram_outbound
  -> Go Telegram bot
```

The web server serves:

- `GET /dashboard` - live log dashboard.
- `GET /alerts` - recent and live alert view.
- `GET /metrics` - application health analytics.
- `GET /config` - admin configuration and user management.
- `POST /login` - demo login endpoint.
- `GET /api/ws` - WebSocket endpoint.
- `GET /api/logs/recent` - recent logs with backend session checks.
- `GET /api/alerts/recent` - recent Redis-backed alerts with backend session checks.
- `GET /api/analytics/health` - ClickHouse-backed hourly health data.
- `GET|POST /api/config/ttl` - alert deduplication TTL.
- `GET|POST /api/config/noti-ttl` - alert notification retention TTL.
- `GET|POST /api/config/clickhouse-ttl` - ClickHouse TTL setting.
- `GET|POST|DELETE /api/users` - admin-only user management.

## Requirements

- Docker with Docker Compose.
- Enough memory to build and run the Python classifier image. It downloads model dependencies during image build/runtime.
- A Telegram bot token only if Telegram delivery is required.

## Configuration

Copy `.env.example` to `.env` and adjust values:

```bash
cp .env.example .env
```

Important values:

- `SERVER_PORT` - host port for the web server. The example uses `3001`; Compose falls back to `3000` if unset.
- `CLICKHOUSE_USER`, `CLICKHOUSE_PASSWORD`
- `POSTGRES_USER`, `POSTGRES_PASSWORD`
- `TELEGRAM_BOT_TOKEN`

Configuration is not fully centralized yet. Internal service addresses, topic names, some default credentials, and several script values are still hardcoded in Compose, pipeline YAML, and worker code.

## Start

```bash
docker compose up -d
```

Then open:

```text
http://localhost:${SERVER_PORT}/dashboard
```

With the provided `.env.example`, that is:

```text
http://localhost:3001/dashboard
```

## Demo Accounts

These accounts are created automatically if the `users` table is empty:

| User | Password | Role | Applications |
| --- | --- | --- | --- |
| `Ayin` | `admin123` | Admin | All |
| `Benjamin` | `eng123` | Engineer | `su(pam_unix),logrotate,syslogd 1.4.1` |
| `Carmen` | `eng123` | Engineer | `ftpd,snmpd,cups,sshd(pam_unix)` |

Do not use these defaults outside a local demo.

## Topics

The code expects these Redpanda topics:

- `logs-ingested`
- `logs-normalized`
- `logs-persist`
- `logs-classified`
- `alerts-ingested`
- `dlq-logs`
- `dlq-clickhouse`

Create them with:

```bash
./scripts/setup-topics.sh
```

## Demo And Test Scripts

The scripts in `scripts/` are intended to be runnable from anywhere and now use the Compose-internal Pandaproxy path instead of assuming host port `8082` is published:

- `test.sh` sends exactly 500 logs in 2 seconds and expects exactly 500 rows after a prior cleanup.
- `test-extreme.sh` is a configurable higher-rate k6 load generator.
- `test-alert.sh` sends repeated critical logs.
- `test-simple.sh` sends five example logs.
- `verify_features.sh` smoke-tests login, metrics, log history, and Redis pub/sub events.
- `cleanup.sh` truncates ClickHouse demo tables and flushes Redis.

Recommended local demo sequence:

```bash
./scripts/setup-topics.sh
./scripts/cleanup.sh
./scripts/test.sh
./scripts/verify_features.sh
```

## Known Limitations

- No dedicated authenticated ingestion API is implemented. Direct Pandaproxy ingestion is not suitable as a public API.
- Processing statuses are transient UI events, not persisted `Raw -> Normalized -> Stored` state transitions.
- WebSocket RBAC needs tightening. Non-admin users currently subscribe to the global log topic as well as app-specific topics.
- Alert deduplication does not match the original exact requirement. It notifies on first occurrence and threshold counts rather than producing exactly one notification for 100 identical errors within one minute.
- ClickHouse schema and queries need tuning for application/level filters.
- `docker-compose.yml` uses some `latest` images and does not define persistent named volumes for Redpanda, Redis, Postgres, or ClickHouse data.
- There are still stale or redundant files and schema artifacts, including `schema.json`, `test-ws.js`, the unused `logrider.logs` / `logs_raw_null` / `logs_enriched_mv` ClickHouse objects, and media files that are not part of the running stack.

## Benchmarks
Updated: 046d47b7fbf81b75816ba2edabccae9764ad5176

A comprehensive benchmark suite exists in `benchmarks/`. It measures throughput, persistence latency, alert deduplication logic, and websocket read performance across both HTTP and gRPC protocols.

### How to run benchmarks
You can run a benchmark scenario from anywhere:
```bash
# Run a single basic correctness check:
./benchmarks/run.sh smoke

# Run a specific benchmark (e.g., alert dedup validation)
./benchmarks/run.sh alert-dedup

# Run all benchmarks sequentially
./benchmarks/run.sh all
```

Results (including summaries, metrics, and raw logs) are generated in `benchmarks/results/<timestamp>-<scenario>/`.

*Note: Benchmarks test both gRPC ingestion (via port 50051) as well as standard HTTP (via port 8082).*

## Incident Fingerprinting v2

LogRider has been upgraded to a v2 incident fingerprinting strategy that replaces the obsolete 32-bit MD5 truncation with a collision-resistant, semantic SHA-256 fingerprint.

### Signature Version
The `ALERT_SIGNATURE_VERSION` must be explicitly configured to `2`. There is no silent fallback to v1 behavior. This ensures identical failures group deterministically across all replicas.

### Grouping Inputs
Incidents are grouped according to the configured `alert.grouping_strategy`. The recommended strategy is `app_level_template`, which combines:
1. Normalized Application Name
2. Normalized Severity Level
3. Conservatively Normalized Message Template

### Normalization Rules
To prevent volatile values from fragmenting single operational failures, the message template replaces the following with canonical placeholders (e.g., `<uuid>`, `<timestamp>`, `<id>`):
- UUIDs
- ISO-8601 Timestamps
- Trace/Request/Correlation IDs (while preserving the field name)
- Memory Addresses
- Stack-frame Line Numbers (while preserving the file and function name)
- IPv4/IPv6 Addresses
- Long Generated Decimal Identifiers

**Known Trade-offs:**
- **Over-grouping:** The `message_template_only` strategy will group completely unrelated applications if they emit identical log text. This is why `app_level_template` is the recommended default.
- **Under-grouping:** The normalizer deliberately leaves HTTP status codes, error codes, and short numeric values intact. As a result, `HTTP 404` and `HTTP 500` for the same route will produce distinct incidents, rather than a single grouped failure. This is generally preferred but should be noted.

### Collision Properties
By hashing a canonical JSON representation of the grouping inputs with full 256-bit SHA-256, accidental hash collisions are made practically impossible, preventing unrelated failures from merging and corrupting counts or timestamps.

### TTL Semantics
Redis key expiration relies on processing time, not log event timestamps. This prevents an old or malicious log timestamp from bypassing the configured alert TTL.

### Migration Behavior
A gradual migration strategy is supported:
1. The Telegram bot worker processes both `incident:<app>:<hash>` (v1) and `incident:v2:<sha256>` (v2) keys.
2. V2 introduces a canonical JSON structure internally; no routing data is derived by parsing the colon-separated key.
3. Legacy v1 incident keys must be allowed to expire naturally according to their existing Redis TTL. Do not bulk-delete them during rollout to preserve active Telegram notification editing.
