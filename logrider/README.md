# LogRider

LogRider is a high-performance, real-time distributed log ingestion, processing, and visualization pipeline. 

## 🏗 Architecture

The system utilizes a heavily optimized, multi-tier architecture to handle high throughput and real-time observability:

- **Web Server (Bun)**: Extremely lean native Bun server exposing the HTTP log ingestion API (`/api/logs`), handling Role-Based Access Control (RBAC) via Postgres, serving the real-time WebSocket dashboard, and executing health analytics.
- **Redpanda**: High-performance Kafka-compatible broker receiving raw logs (`logs-raw`) and staging normalized logs (`logs-normalized`).
- **Benthos (Unified Pipeline)**: A stream processor that consumes `logs-raw`, normalizes payloads (timestamps, uppercase levels, UUID generation), and fans out to ClickHouse (persistence), Redis (`ws-logs` streaming), and Redpanda (`logs-normalized`).
- **Redis**: 
  - Acts as a real-time Pub/Sub broker (`ws-logs`, `ws-tags`, and `alerts`).
  - Manages session caching and stateful **Alert Deduplication** using dynamic TTLs.
- **Alert Worker (Bun)**: A lightweight daemon running on Bun, subscribing to Redis `ws-logs`. It evaluates `ERROR` and `CRITICAL` logs, deduplicates burst errors using Redis atomic counters, and broadcasts to the `alerts` channel.
- **Classifier Worker (Node.js)**: An AI worker that consumes from the `logs-normalized` Kafka topic, dynamically assigns categorical tags to the logs, persists them to a separate ClickHouse `log_tags` table, and pushes real-time metadata over Redis `ws-tags`.
- **ClickHouse**: Columnar database acting as the permanent storage layer. Configured with a built-in **7-day Time-To-Live (TTL)** retention policy to auto-prune stale logs.
- **PostgreSQL**: Manages users and application permissions.

## 🚀 Quick Start

Ensure you have Docker and `docker-compose` installed.

### 1. Boot the Infrastructure
Start the entire stack (Data Tier, Benthos Pipeline, Workers, and Web Server) using Docker:
```bash
docker compose up -d
```
*(Note: Postgres and ClickHouse will auto-initialize their schemas and mock data on the first boot).*

The Web Server will automatically boot and bind to port `3000`.

## 📊 Dashboard & Analytics

Navigate to [http://localhost:3000/dashboard](http://localhost:3000/dashboard).

The system comes with **Role-Based Access Control (RBAC)** initialized via Postgres. 

**Mock Accounts:**
- **Admin**: `admin` / `admin123` (Full visibility into all logs across the cluster, can modify the Deduplication TTL in real-time).
- **Engineer 1**: `eng1` / `eng123` (Restricted visibility to `payment` and `auth` applications).
- **Engineer 2**: `eng2` / `eng123` (Restricted visibility to `load-test-app`).

**Features:**
- **Real-Time Logs**: WebSockets stream incoming logs natively to the UI based on your permissions.
- **Real-Time AI Tags**: As the Classifier Worker categorizes logs asynchronously, tags automatically attach to rendered logs in the dashboard instantly without a page refresh.
- **Health Analytics**: A dynamic Chart.js visualization queries ClickHouse to display the Error Rate (%) across all applications by the hour, helping identify unstable systems.
- **Live TTL Configuration**: Admins can change the Alert Deduplication Time-To-Live globally without restarting any workers.

## 🧪 Testing

We provide two concurrent load-testing scripts to simulate intense production traffic. They utilize `python` and concurrent requests to stress-test the ingestion API.

1. **Standard Ingestion Test**: Fires 500 standard logs instantly using concurrent execution. The script will generate logs for diverse applications (`payment`, `auth`, `inventory`, etc.) with precise millisecond timestamps and unique Trace IDs. It will wait for the pipeline to flush and query ClickHouse to verify end-to-end ingestion success.
   ```bash
   bash ./scripts/test.sh
   ```
   **To verify RBAC Rules:** Login to the dashboard as `eng1` or `eng2` and observe that the real-time stream and historical logs only display logs for applications that the specific engineer is authorized to view.

2. **Alert Burst Test**: Fires 500 CRITICAL error logs for the `payment` app instantly. You will see the Alert Worker successfully broadcast the initial alert and suppress/deduplicate the remaining 499 in the terminal and dashboard.
   ```bash
   bash ./scripts/test-alert.sh
   ```
