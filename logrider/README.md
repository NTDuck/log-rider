# LogRider

LogRider is a high-performance, real-time distributed log ingestion, processing, and visualization pipeline capable of handling 1M+ logs/sec.

## 🏗 Architecture

The system utilizes a heavily optimized, multi-tier architecture to handle extreme throughput and real-time observability:

- **Redpanda & Pandaproxy**: High-performance Kafka-compatible broker. The ingestion route directly hits Pandaproxy (`http://localhost:8082/topics/logs-raw`) using HTTP POSTs (e.g. from `test-alert.sh`), bypassing the Node/Bun event loop entirely to avoid KafkaJS serialization bottlenecks.
- **Benthos (Unified Pipeline)**: A stream processor that consumes `logs-raw`, normalizes payloads, and routes logs. It features:
  - **Optimized ClickHouse Sinks**: Uses a `fallback` DLQ block with high-throughput batching (100k/5s) for ClickHouse, converting timestamps to UNIX milliseconds for zero-overhead insertion.
  - **Redis Protection via Sampling**: Employs deterministic sampling (via `Trace_ID` suffixes) to push a safe fraction of live logs and lifecycle statuses (`Ingested`, `Normalized`, `Persisted`) to the `ws-logs` Redis channel.
  - **Kafka Stripping**: Drops heavy `Message` payloads before re-publishing to `logs-normalized` to reduce write amplification for downstream consumers.
- **Redis**: 
  - Acts as a real-time Pub/Sub broker for `alerts-raw`, `ws-logs`, `ws-tags`, and processed `alerts`.
  - Manages session caching and stateful **Alert Deduplication** using atomic counters and dynamic TTLs.
- **PostgreSQL**: Stateful, durable storage for user accounts, credentials, and RBAC configurations.
- **Alert Worker (Bun)**: A lightweight daemon subscribing to Redis `alerts-raw`. It deduplicates burst errors using Redis and broadcasts verified alerts to the `alerts` channel.
- **Classifier Worker (Node.js)**: Consumes from the `logs-normalized` topic, dynamically assigns categorical tags to the logs, securely persists them via `JSONEachRow` to ClickHouse, and broadcasts to the `ws-tags` Redis channel.
- **ClickHouse**: Columnar database acting as the permanent storage layer. Configured with native `UUID` types for fast `JOIN`s, and a built-in **7-day Time-To-Live (TTL)** retention policy to auto-prune stale logs.
- **Web Server (Bun)**: Extremely lean native Bun server managing WebSockets, RBAC authentication (verifying bcrypt passwords against Postgres, issuing `crypto.randomBytes` session tokens), and dynamic HTML rendering.

## 🚀 Quick Start

Ensure you have Docker and `docker-compose` installed.

### 1. Boot the Infrastructure
Start the entire stack (Data Tier, Benthos Pipeline, Workers, and Web Server) using Docker:
```bash
docker compose up -d
```
*(Note: ClickHouse and Postgres will auto-initialize their schemas on the first boot).*

The Web Server will automatically boot and bind to port `3000`.

## 📊 Dashboard & Analytics

Navigate to [http://localhost:3000/dashboard](http://localhost:3000/dashboard). The UI is heavily inspired by the AWS Management Console for a premium, familiar developer experience.

The system comes with **Role-Based Access Control (RBAC)** initialized securely in Postgres on startup.

**Mock Accounts:**
- **Admin**: `admin` / `admin123` (Full visibility into all logs across the cluster, can modify the Deduplication TTL in real-time).
- **Engineer 1**: `eng1` / `eng123` (Restricted visibility to `apple-service`, `banana-service`, and `orange-service`).
- **Engineer 2**: `eng2` / `eng123` (Restricted visibility to `kiwi-service` and `papaya-service`).

**Features:**
- **Real-Time Logs & Lifecycle Tracking**: WebSockets stream incoming logs and track their exact stage through the pipeline (`Ingested` -> `Normalized` -> `Persisted` -> `Classified`) natively in the UI.
- **Health & Metrics Dashboard**: The dedicated `/metrics` page features a dynamic Chart.js visualization of the Error Rate (%) across all applications by the hour, and an Error Leaderboard.
- **Live TTL Configuration**: Admins can change the Alert Deduplication Time-To-Live globally without restarting any workers from the `/config` page.

## 🧪 Testing

We provide load-testing scripts to simulate intense production traffic. Tests can be run inside the project's nix-shell.

1. **Standard Ingestion Test**: Fires 500 standard logs using `k6`. The script generates logs for random fruit-named microservices (`apple-service`, `banana-service`, etc.) with precise millisecond timestamps and unique UUIDs. It directly hits Redpanda's HTTP proxy.
   ```bash
   nix-shell ../shell.nix --run ./scripts/test.sh
   ```
   **To verify RBAC Rules:** Login to the dashboard as `eng1` or `eng2` and observe that the real-time stream and historical logs *only* display logs for the specific fruit microservices that the engineer is authorized to view.

2. **Extreme Load Test**: Fires 1 Million logs in massive bursts to test the architecture limits. Benthos will easily batch-insert these into ClickHouse, and the Web Server will safely stream a deterministic sample to the dashboard without crashing.
   ```bash
   nix-shell ../shell.nix --run ./scripts/test-extreme.sh
   ```

3. **Single Alert Test**: Fires a single test log directly to the Redpanda HTTP Proxy.
   ```bash
   nix-shell ../shell.nix --run ./scripts/test-alert.sh
   ```
