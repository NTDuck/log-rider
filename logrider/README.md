# LogRider

LogRider is a high-performance, real-time distributed log ingestion, processing, and visualization pipeline. 

## 🏗 Architecture

The system utilizes a heavily optimized, multi-tier architecture to handle high throughput and real-time observability:

- **Web Server (Node.js)**: Exposes the HTTP log ingestion API (`/api/logs`), handles Role-Based Access Control (RBAC) via Postgres, serves the real-time WebSocket dashboard, and exposes health analytics.
- **Redpanda**: High-performance Kafka-compatible broker receiving raw logs (`logs-raw`).
- **Benthos (Unified Pipeline)**: A stream processor that consumes `logs-raw`, normalizes payloads (timestamps, uppercase levels, UUID generation), and fans out to both ClickHouse (for persistence) and Redis (for real-time streaming).
- **Redis**: 
  - Acts as a real-time Pub/Sub broker (`ws-logs` and `alerts`).
  - Manages session caching.
  - Implements stateful **Alert Deduplication** using dynamic TTLs.
- **Alert Worker (Node.js)**: A lightweight daemon subscribing to Redis `ws-logs`. It evaluates `ERROR` and `CRITICAL` logs, deduplicates burst errors using Redis atomic counters, and broadcasts to the `alerts` channel.
- **ClickHouse**: Columnar database acting as the permanent storage layer. Configured with a built-in **7-day Time-To-Live (TTL)** retention policy to auto-prune stale logs.
- **PostgreSQL**: Manages users and application permissions.

## 🚀 Quick Start

Ensure you have Docker, `docker-compose`, and Node.js 20+ installed.

### 1. Boot the Infrastructure
Start the data tier (Redpanda, Redis, ClickHouse, Postgres) along with the Unified Benthos Pipeline and the Alert Worker:
```bash
cd persist
docker compose up -d
```
*(Note: Postgres and ClickHouse will auto-initialize their schemas and mock data on the first boot).*

### 2. Start the Web Server
In a separate terminal window, start the Node.js API and Dashboard server:
```bash
cd server
npm install
npm start
```
The server will boot on port `3000`.

## 📊 Dashboard & Analytics

Navigate to [http://localhost:3000/dashboard](http://localhost:3000/dashboard).

The system comes with **Role-Based Access Control (RBAC)** initialized via Postgres. 

**Mock Accounts:**
- **Admin**: `admin` / `admin123` (Full visibility into all logs across the cluster, can modify the Deduplication TTL in real-time).
- **Engineer 1**: `eng1` / `eng123` (Restricted visibility to `payment` and `auth` applications).
- **Engineer 2**: `eng2` / `eng123` (Restricted visibility to `load-test-app`).

**Features:**
- **Real-Time Logs**: WebSockets stream incoming logs natively to the UI based on your permissions.
- **Health Analytics**: A dynamic Chart.js visualization queries ClickHouse to display the Error Rate (%) across all applications by the hour, helping identify unstable systems.
- **Live TTL Configuration**: Admins can change the Alert Deduplication Time-To-Live globally without restarting any workers.

## 🧪 Testing

We provide two concurrent load-testing scripts to simulate intense production traffic. They utilize `xargs` to stress-test the ingestion API.

1. **Standard Ingestion Test**: Fires 500 standard logs instantly.
   ```bash
   bash ./scripts/test.sh
   ```

2. **Alert Burst Test**: Fires 500 CRITICAL error logs for the `payment` app instantly. You will see the Alert Worker successfully broadcast the initial alert and suppress/deduplicate the remaining 499 in the terminal and dashboard.
   ```bash
   bash ./scripts/test-alert.sh
   ```
