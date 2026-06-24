# Logger - High-Throughput Log Collection Monolith

A high-throughput, horizontally scalable Log Collection and Processing monolith built in Rust. It utilizes **Tokio** for asynchronous actor-based concurrency, **Kafka/Redpanda** for messaging and backpressure, **ClickHouse** for high-volume storage, **Redis** for state distribution and rate-limiting, and **ONNX** for local ML inference.

## Architecture & Roles

This single binary contains 8 distinctly decoupled roles. They communicate exclusively through Kafka topics or database instances. You run multiple processes of the same binary with different `--role` flags to scale parts of the pipeline independently.

1. **Edge Receiver** (`--role edge`): Ingests OTLP JSON logs over HTTP, flattens them, validates JWT app-grants, and produces them to `logs-raw`.
2. **Normalization Worker** (`--role normalization`): Consumes `logs-raw`, applies regex-based PII redaction, duplicates critical errors to an alerting stream, and writes to `logs-normalized`.
3. **DB Writer** (`--role db-writer`): Consumes `logs-normalized` and efficiently batches them via `JSONEachRow` into ClickHouse.
4. **AI Consumer** (`--role ai-consumer`): Consumes `logs-normalized`, runs local ONNX models for semantic tagging, and publishes tags to `ai-tags-stream`.
5. **Alert Consumer** (`--role alert-consumer`): Consumes `alerts-priority-stream`, applies token-bucket deduplication via Redis Lua scripts, and sends notifications to Telegram.
6. **WebSocket Server** (`--role ws-server`): Consumes `logs-normalized` and broadcasts them to active WebSocket clients with strict JWT RBAC (Role-Based Access Control).
7. **Admin API** (`--role admin-api`): HTTP API for dynamically updating alert configurations. Broadcasts updates to the Alert Consumer via Redis Pub/Sub.
8. **AI Tag Projection** (`--role ai-tag-projection`): Consumes `ai-tags-stream` and writes AI classification tags to ClickHouse.

## Dependencies

- **Rust / Cargo** (stable)
- **Nix** (Highly recommended for reproducible development environments. The `shell.nix` provides all C dependencies like `librdkafka`, `openssl`, `pkg-config`, etc.)
- **Kafka / Redpanda** (Brokers)
- **ClickHouse**
- **Redis**

## Configuration Setup

Before building or running the monolith, configure your environment variables.

```bash
# Copy the example environment file
cp .env.example .env
```

### 1. Generating a JWT Public Key
The Edge Receiver and WebSocket Server enforce Role-Based Access Control (RBAC) purely through mathematical JWT signature validation. To generate an RSA keypair for signing and verifying tokens:

```bash
# Generate a private key (Used by your auth service to sign tokens)
openssl genpkey -algorithm RSA -out private_key.pem -pkeyopt rsa_keygen_bits:2048

# Extract the public key (Used by this monolith to verify tokens)
openssl rsa -pubout -in private_key.pem -out public_key.pem
```
Copy the entire contents of `public_key.pem` (including the `-----BEGIN PUBLIC KEY-----` and `-----END PUBLIC KEY-----` headers) and paste it into the `JWT_PUBLIC_KEY` variable in your `.env` file. Enclose it in quotes if necessary.

### 2. Setting up Telegram Alerts
The Alert Consumer deduplicates and forwards `ERROR` and `CRITICAL` logs to a Telegram chat.

1. **Obtain a Bot Token**: Open Telegram and search for `@BotFather`. Send the `/newbot` command and follow the prompts. BotFather will provide an HTTP API Token. Paste this into `TELEGRAM_TOKEN` in your `.env` file.
2. **Obtain a Chat ID**: 
   - Create a Telegram group or channel.
   - Add your newly created bot to the group.
   - Send a test message in the group.
   - Open your browser to `https://api.telegram.org/bot<YOUR_TELEGRAM_TOKEN>/getUpdates`.
   - Find the `"chat":{"id": -123456789}` field in the JSON response. Paste that exact number into `TELEGRAM_CHAT_ID` in your `.env` file.

## Building & Installation

To reliably build the project, use the provided `docker-compose.yml` environment, which requires zero manual intervention and provides all necessary dependencies, topic provisioning, and ClickHouse tables automatically.

```bash
# Start the entire monolith and all databases
docker compose up --build
```

For local development without Docker, use the provided `nix-shell` environment. It ensures that system dependencies like `librdkafka` and `openssl` are present.

```bash
# Enter the nix shell
nix-shell

# Build the workspace
cargo build --release

# Run tests
cargo test --workspace
```

## Running the Application

Each component of the system is launched using the `--role` flag. The monolith uses environment variables or explicit flags for configuration.

### Shared Environment Variables / Flags:

- `--kafka-brokers` (Default: `127.0.0.1:9092`)
- `--jwt-public-key` / `JWT_PUBLIC_KEY`
- `--clickhouse-url` / `CLICKHOUSE_URL` (Default: `http://localhost:8123`)
- `--redis-url` / `REDIS_URL` (Default: `redis://localhost:6379/`)
- `--telegram-token` / `TELEGRAM_TOKEN`
- `--telegram-chat-id` / `TELEGRAM_CHAT_ID`
- `--admin-api-url` / `ADMIN_API_URL` (Default: `http://localhost:8081`)

### Starting the Services Manually:

If you are running manually via Cargo (not using `docker-compose`), the application will automatically read the `.env` file for configuration. You only need to specify the `--role`.

```bash
# 1. Edge Receiver (Listens on 0.0.0.0:8080)
cargo run --release -- --role edge

# 2. Normalization Worker
cargo run --release -- --role normalization

# 3. DB Writer
cargo run --release -- --role db-writer

# 4. AI Consumer (Requires ONNX model)
cargo run --release -- --role ai-consumer

# 5. Alert Consumer
cargo run --release -- --role alert-consumer

# 6. WebSocket Server (Listens on 0.0.0.0:8081)
cargo run --release -- --role ws-server

# 7. Admin API (Listens on 0.0.0.0:8082)
cargo run --release -- --role admin-api

# 8. AI Tag Projection
cargo run --release -- --role ai-tag-projection
```

## Resilience & Guarantees

- **CPU-Safe Retry Backoffs**: All failure loops use strict `tokio::select!` cancellation tokens paired with `tokio::time::sleep` to avoid CPU spinning.
- **Kafka Backpressure**: Bounded `mpsc` channels correctly separate `Consumer` tasks from processing logic, ensuring the network listener never drops bytes due to application latency.
- **Terminal Telemetry Gates**: Prometheus metrics (`logger_events_processed_total`) are incremented strictly _after_ I/O tasks are `await`ed and resolved successfully.
- **Zero-Block Async**: Blocking I/O (`std::thread::sleep`, `reqwest::blocking`) is strictly prohibited to prevent Tokio executor thread starvation.

## Architecture Council Audit

The entire codebase and container infrastructure have been rigorously evaluated and statically analyzed by the LLM Architecture Council against 7 specialized personas (Tokio Warden, Observability Inspector, Topology Tracer, Boundary Enforcer, DevOps & DX Architect, and Hardened Specs Enforcer). 

Read the definitive **[Monolith Architecture Code Audit](specs/05-execution/v5/eval/monolith-code-audit.md)** for details on the attack vectors tested and the surgical fixes applied to guarantee production readiness.