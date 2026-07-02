# LogRider

LogRider is a high-performance, real-time distributed log ingestion, processing, and visualization pipeline capable of handling 1M+ logs/sec.

## 🏗 Architecture

The system utilizes a heavily optimized, multi-tier architecture to handle extreme throughput and real-time observability:

- **Redpanda & Pandaproxy**: High-performance Kafka-compatible broker. The ingestion route directly hits Pandaproxy (`http://localhost:8082/topics/logs-raw`) using HTTP POSTs, bypassing the Node/Bun event loop entirely to avoid KafkaJS serialization bottlenecks.
- **Benthos (Unified Pipeline)**: A stream processor that consumes `logs-raw`, normalizes payloads (timestamps to `DateTime64(3)`), and routes logs. To prevent Redis from being overwhelmed, it uses a `switch` output to only fan out `ERROR` and `CRITICAL` logs to the `alerts-raw` Redis channel. All logs are securely persisted to ClickHouse.
- **Redis**: 
  - Acts as a real-time Pub/Sub broker for `alerts-raw` and processed `alerts`.
  - Manages session caching and stateful **Alert Deduplication** using atomic counters and dynamic TTLs.
- **Alert Worker (Bun)**: A lightweight daemon subscribing to Redis `alerts-raw`. It deduplicates burst errors using Redis and broadcasts verified alerts to the `alerts` channel.
- **Classifier Worker (Node.js)**: Consumes from the `logs-normalized` topic, dynamically assigns categorical tags to the logs, and securely persists them via `JSONEachRow` to ClickHouse.
- **ClickHouse**: Columnar database acting as the permanent storage layer. Configured with native `UUID` types for fast `JOIN`s, and a built-in **7-day Time-To-Live (TTL)** retention policy to auto-prune stale logs.
- **Web Server (Bun)**: Extremely lean native Bun server managing O(K) mapped WebSocket broadcasts, RBAC authentication (in-memory bcrypt), and health analytics. Real-time log streaming is achieved safely by polling ClickHouse on an interval, preventing browser crashes under extreme load.

## 🚀 Quick Start

Ensure you have Docker and `docker-compose` installed.

### 1. Boot the Infrastructure
Start the entire stack (Data Tier, Benthos Pipeline, Workers, and Web Server) using Docker:
```bash
docker compose up -d
```
*(Note: ClickHouse will auto-initialize its schema on the first boot).*

The Web Server will automatically boot and bind to port `3000`.

## 📊 Dashboard & Analytics

Navigate to [http://localhost:3000/dashboard](http://localhost:3000/dashboard).

The system comes with **Role-Based Access Control (RBAC)** initialized securely in the Web Server memory. 

**Mock Accounts:**
- **Admin**: `admin` / `admin123` (Full visibility into all logs across the cluster, can modify the Deduplication TTL in real-time).
- **Engineer 1**: `eng1` / `eng123` (Restricted visibility to `apple-service`, `banana-service`, and `orange-service`).
- **Engineer 2**: `eng2` / `eng123` (Restricted visibility to `kiwi-service` and `papaya-service`).

**Features:**
- **Real-Time Logs**: WebSockets stream incoming logs natively to the UI based on your permissions.
- **Health Analytics**: A dynamic Chart.js visualization queries ClickHouse to display the Error Rate (%) across all applications by the hour, helping identify unstable systems.
- **Live TTL Configuration**: Admins can change the Alert Deduplication Time-To-Live globally without restarting any workers.

## 🧪 Testing

We provide load-testing scripts using Grafana `k6` to simulate intense production traffic. Tests can be run inside the project's nix-shell.

1. **Standard Ingestion Test**: Fires 500 standard logs using `k6`. The script generates logs for random fruit-named microservices (`apple-service`, `banana-service`, etc.) with precise millisecond timestamps and unique UUIDs. It directly hits Redpanda's HTTP proxy.
   ```bash
   nix-shell ../shell.nix --run ./scripts/test.sh
   ```
   **To verify RBAC Rules:** Login to the dashboard as `eng1` or `eng2` and observe that the real-time stream and historical logs *only* display logs for the specific fruit microservices that the engineer is authorized to view.

2. **Extreme Load Test**: Fires 1 Million logs in massive bursts to test the architecture limits. Benthos will easily batch-insert these into ClickHouse, and the Web Server will safely sample/poll them for the dashboard without crashing.
   ```bash
   nix-shell ../shell.nix --run ./scripts/test-extreme.sh
   ```
