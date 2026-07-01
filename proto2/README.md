# Docili Log Server

A high-performance log ingestion and parsing server built in Rust, designed for real-time log processing with pattern-based parsing and ClickHouse integration.

## Features

- **High-Performance Log Ingestion**: Actix-web based HTTP API for receiving log data
- **Pattern-Based Parsing**: Automatic log pattern detection and dissection
- **ClickHouse Integration**: Efficient batch insertion into ClickHouse database
- **Correlation Engine**: Rule-based log correlation for anomaly detection
- **Concurrent Processing**: Lock-free data structures with double-buffering for high throughput
- **Scheduled Batch Inserts**: Configurable cron-based batch processing

## Architecture

### Core Components

- **API Layer**: RESTful endpoints for log ingestion
- **Pattern Parser**: Dynamic pattern generation and dissection engine
- **Block Manager**: Double-buffered block storage for concurrent writes
- **Scheduler**: Periodic batch insertion to ClickHouse
- **Correlation Engine**: Rule-based log event correlation

### Technology Stack

- **Runtime**: Tokio async runtime
- **Web Framework**: Actix-web 4.x
- **Database**: ClickHouse (via clickhouse-rs)
- **Concurrency**: DashMap, Atomic operations
- **Logging**: Tracing with file rotation
- **Serialization**: Serde, serde_json

## Getting Started

### Prerequisites

- Rust 1.70+ (2021 edition)
- ClickHouse server running on localhost:9000
- Access to ClickHouse database

### Installation

1. Clone the repository:
```bash
git clone <repository-url>
cd docili-log-server
```

2. Copy the example environment file and configure:
```bash
cp .env.example .env
```

3. Edit `.env` with your configuration:
```env
DATABASE_URL=tcp://username:password@localhost:9000/database_name?compression=lz4
SERVER_HOST=0.0.0.0
SERVER_PORT=8081
SERVER_WORKERS=2
LOG_DIR=./logs
```

4. Build the project:
```bash
cargo build --release
```

5. Run the server:
```bash
cargo run --release
```

## Configuration

All configuration is managed through environment variables. See `.env.example` for available options:

| Variable | Description | Default |
|----------|-------------|---------|
| `DATABASE_URL` | ClickHouse connection string | Required |
| `SERVER_HOST` | Server bind address | `0.0.0.0` |
| `SERVER_PORT` | Server port | `8081` |
| `SERVER_WORKERS` | Number of worker threads | `2` |
| `LOG_DIR` | Directory for application logs | `./logs` |
| `LOG_FILE` | Path to test log file | `./test_logs/line_1m.log` |

## API Endpoints

### POST /api/v1

Ingest log data for processing.

**Headers:**
- `x-api-key`: Folder identifier for pattern mapping (required)
- `Content-Type`: Content type of the log data

**Request Body:**
Raw log text

**Response:**
- `200 OK`: Log processed successfully
- `400 Bad Request`: Missing required headers
- `500 Internal Server Error`: Processing failed

**Example:**
```bash
curl -X POST http://localhost:8081/api/v1 \
  -H "x-api-key: s5" \
  -H "Content-Type: text/plain" \
  -d "117.62.214.98 - waters1728 [08/Sep/2024:10:42:47 +0530] \"POST /api/logs HTTP/1.1\" 200 1234"
```

## Pattern Parsing

The server uses a dissect-style pattern parsing engine that automatically detects log patterns and extracts structured data.

### Pattern Format

Patterns use `%{field_name}` syntax with optional type conversions:

```
%{host} - %{user} [%{timestamp}] "%{method} %{path} %{protocol}" %{status:int} %{bytes:int}
```

### Supported Types
- `string` (default)
- `int` - Integer conversion
- `float` - Float conversion

### Pattern Modifiers
- `?` - Ignore field (don't capture)
- `&` - Lookup field (reference previously captured value)
- `+` - Append to previous field
- `_` - Padding (whitespace handling)

## Log Correlation

The correlation engine supports complex rule-based log correlation with:

- **Field Matching**: Equality checks on log fields
- **Logical Operators**: ANY (OR) and ALL (AND) combinations
- **Occurrence Counting**: Time-based occurrence thresholds
- **Follow-up Rules**: Chained rule evaluation
- **Time Windows**: Minutes, hours, days

### Rule Structure

```json
{
  "group": {
    "Any": [
      {
        "All": [
          {
            "Any": [
              {
                "field": "method",
                "val": {"Any": ["GET"]}
              }
            ]
          },
          {
            "Any": [
              {
                "field": "status",
                "val": {"Any": [400, 401]}
              }
            ]
          }
        ]
      }
    ]
  },
  "occurrence_count": {
    "period": 10,
    "period_type": "Minutes",
    "count": 3
  }
}
```

## Performance

- **Concurrent Processing**: Lock-free data structures for minimal contention
- **Batch Insertion**: Configurable batch sizes for optimal throughput
- **Double Buffering**: Non-blocking writes during database operations
- **Efficient Parsing**: Zero-copy string operations where possible

## Development

### Project Structure

```
src/
├── api/           # HTTP API endpoints
├── parser/        # Pattern parsing and dissection
├── utils/         # Utilities (logging, config)
├── correlation.rs # Log correlation engine
├── config.rs      # Configuration management
└── main.rs        # Application entry point
```

### Running Tests

```bash
cargo test
```

### Code Style

The project follows Rust standard formatting:
```bash
cargo fmt
cargo clippy
```

## License

This project is proprietary software. All rights reserved.

## Contributing

This is a portfolio project. For inquiries or collaboration opportunities, please contact the repository owner.

## Acknowledgments

- Built with Actix-web for high-performance HTTP handling
- Uses ClickHouse for efficient log storage and analytics
- Pattern parsing inspired by Elasticsearch dissect processor
