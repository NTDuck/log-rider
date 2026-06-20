# System Boundary Map

```text
+-------------------+       +-----------------------+       +-------------------+
|                   |       |                       |       |                   |
|  OTLP Producers   +------>+  Edge Receiver API    +------>+    Redpanda       |
|  (Apps / Agents)  | JWT   |  (POST /api/v1/logs)  | HTTP  |  (logs-raw)       |
|                   |       |                       |       |                   |
+-------------------+       +-----------------------+       +---------+---------+
                                                                      |
                                                                      v
+-------------------+       +-----------------------+       +---------+---------+
|                   |       |                       |       |                   |
|     Redis         +<------+   Rust Workers        +<------+   Custom Worker   |
| (Counters/Limits) | Redis |   (Alert Consumer)    | Stream|   (ETL / Scrub)   |
|                   |       |                       |       |                   |
+---------+---------+       +-----------+-----------+       +---------+---------+
          |                             |                             |
          v                             v                             v
+-------------------+       +-----------------------+       +---------+---------+
|                   |       |                       |       |                   |
|  Control Plane    |       |   Telegram Webhook    |       |  Redpanda Topics  |
|  (Admin Config)   |       |   (Alerts)            |       | (normalized, dlq, |
|                   |       |                       |       |  alerts-priority) |
+---------+---------+       +-----------------------+       +---------+---------+
          |                                                           |
          v                                                           v
+-------------------+       +-----------------------+       +---------+---------+
|                   |       |                       |       |                   |
|   ClickHouse      |<------+     WebSocket API     +<------+     AI Sidecar    |
| (Logs & Sidecars) | Read  |  (Live Stream Viewer) | Stream|    (Classification|
|                   |       |                       |       |                   |
+-------------------+       +-----------------------+       +-------------------+
```
