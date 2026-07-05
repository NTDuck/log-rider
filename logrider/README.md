# LogRider

LogRider is a high-performance, real-time distributed log ingestion, processing, and visualization pipeline capable of handling 1M+ logs/sec.

## 🏗 Architecture

The system utilizes a heavily optimized, multi-tier architecture to handle extreme throughput and real-time observability:

- **Redpanda & Pandaproxy**: High-performance Kafka-compatible broker handling all inter-service messaging via native topics (`logs-ingested`, `logs-persist`, `alerts-ingested`, `logs-normalized`, `logs-classified`, `ws-events`). Ingestion directly hits Pandaproxy (`http://localhost:8082/topics/logs-ingested`) using HTTP POSTs, bypassing Node/Bun event loops.
- **Benthos Pipelines (`unified`, `persist`, `tags`)**: 
  - `unified`: Consumes `logs-ingested`, normalizes payloads, generates UUIDs, and routes to specific Kafka topics.
  - `persist`: Consumes `logs-persist` and performs high-throughput HTTP batch inserts (`JSONEachRow`) into ClickHouse.
  - `tags`: Consumes `logs-classified` and batch inserts AI classifications directly into ClickHouse.
- **Redis**: Functions purely as a high-speed state store for **Alert Deduplication**. Utilizes Redis `pipeline.exec()` coupled with Kafka consumer batching to atomically process thousands of alerts simultaneously via Lua scripts.
- **PostgreSQL**: Stateful, durable storage for user accounts, credentials, and RBAC configurations.
- **Alert Worker (Bun)**: Consumes from the `alerts-ingested` Kafka topic using `kafkajs` batching (`eachBatch`). Deduplicates burst errors via Redis pipelining and natively produces verified alerts to `ws-events`. Replicated 10x via `docker-compose` for massive horizontal scale.
- **Classifier Worker (Python)**: An ultra-fast Python worker built with `confluent-kafka` and `fasttext`. Consumes from `logs-normalized`, performs AI text classifications natively, and produces categorized tags to `logs-classified` and `ws-events`.
- **ClickHouse**: Columnar database acting as permanent storage. Handles extreme ingest rates via decoupled HTTP batch pipelines, and implements a built-in Time-To-Live (TTL) retention policy that can be dynamically updated via the Admin dashboard.
- **Web Server (Bun)**: A pure, dumb rendering layer. Subscribes to the `alerts-state` and `ws-events` Redis channels to stream real-time lifecycle updates seamlessly to connected clients over WebSockets. Handles RBAC and UI serving.

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

Navigate to [http://localhost:3001/dashboard](http://localhost:3001/dashboard). The UI is heavily inspired by the AWS Management Console for a premium, familiar developer experience.

The system comes with **Role-Based Access Control (RBAC)** initialized securely in Postgres on startup.

**Mock Accounts:**
- **Admin**: `admin` / `admin123` (Full visibility into all logs across the cluster, can modify the Deduplication TTL in real-time).
- **Engineer 1**: `eng1` / `eng123` (Restricted visibility to `apple-service`, `banana-service`, and `orange-service`).
- **Engineer 2**: `eng2` / `eng123` (Restricted visibility to `kiwi-service` and `papaya-service`).

**Features:**
- **Real-Time Logs & Lifecycle Tracking**: WebSockets stream incoming logs and track their exact stage through the pipeline (`Ingested` -> `Normalized` -> `Persisted` -> `Classified`) natively in the UI. Advanced global search and interactive chip-based filtering allow for instantaneous log exploration.
- **Active Alerts Dashboard**: A dedicated `/alerts` page for real-time monitoring of critical and error-level logs, featuring active incident tracking and grouped suppression rules to mitigate alert fatigue.
- **Telegram Bot Integration**: Engineers and Admins can receive instant, rate-limited, deduplicated critical error alerts directly in Telegram. The bot strictly enforces the web app's Role-Based Access Control (RBAC).
  - **Setup**: Login to the dashboard, click the **Telegram** button in the top navigation, and copy the provided one-time token.
  - **User Commands**:
    - `/link <token>`: Securely link your account and immediately start receiving alerts for your authorized apps.
    - `/subscribe` & `/unsubscribe`: Toggle your notification stream on or off without unlinking your account.
    - `/status`: View your current RBAC role, linked apps, and notification status.
- **Health & Metrics Dashboard**: The dedicated `/metrics` page features a dynamic Chart.js visualization of the Error Rate (%) across all applications by the hour, and an Error Leaderboard.
- **Live TTL Configuration**: Admins can change the Alert Deduplication TTL (Redis) and the Log Retention TTL policies (ClickHouse) globally on the fly without restarting any services from the `/config` page.

## 🧪 Testing

We provide load-testing scripts to simulate intense production traffic. Tests can be run inside the project's nix-shell.

1. **Standard Ingestion Test**: Fires 500 standard logs using `k6`. The script generates logs for random fruit-named microservices (`apple-service`, `banana-service`, etc.) with precise millisecond timestamps and unique UUIDs. It directly hits Redpanda's HTTP proxy.
   ```bash
   nix-shell ../shell.nix --run ./scripts/test.sh
   ```
   **To verify RBAC Rules:** Login to the dashboard as `eng1` or `eng2` and observe that the real-time stream and historical logs *only* display logs for the specific fruit microservices that the engineer is authorized to view.

2. **Extreme Load Test**: Fires 1 Million logs in massive bursts to test the architecture limits. The distributed Benthos pipelines will batch-insert these securely into ClickHouse, while the Web Server safely consumes streams directly via the native Kafka topics.
   ```bash
   nix-shell ../shell.nix --run ./scripts/test-extreme.sh
   ```

3. **Single Alert Test**: Fires a single test log directly to the Redpanda HTTP Proxy.
   ```bash
   nix-shell ../shell.nix --run ./scripts/test-alert.sh
   ```
