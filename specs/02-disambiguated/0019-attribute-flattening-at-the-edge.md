# 0019. Attribute Flattening at the Edge

## Status
Accepted

## Context
We are supporting structured logging where clients can submit dynamic key-value properties. Often, these logs come in via OTLP (OpenTelemetry Protocol). OTLP natively represents dynamic properties as highly nested `repeated KeyValue` arrays with `AnyValue` unions (e.g., `[{"key": "http", "value": {"kvlistValue": {"values": [{"key": "status", "value": {"intValue": 200}}]}}}]`).

This structure is highly optimized for network serialization (compact binary over gRPC). However, writing this raw, heavily nested array schema directly into ClickHouse is catastrophic for analytical queries.

## Alternatives Considered & The Debate
During the architecture review, the mapping between transport schema and storage schema was heavily scrutinized.

1. **Store Raw OTLP in ClickHouse (Rejected)**
   Pipe the rigid, highly nested OTLP `KeyValue` arrays directly into ClickHouse and rely on advanced array-extraction SQL functions during reads.
   *Why it was rejected:* This destroys query ergonomics. An engineer would have to write complex, unreadable SQL using `arrayFilter` or higher-order functions just to filter by an HTTP status code. Furthermore, ClickHouse's native JSON indices and bloom filters cannot efficiently index these abstract generic arrays. Query performance would tank.

2. **Attribute Flattening at the Edge (Accepted)**
   Explicitly decouple the OTLP Transport Schema from the ClickHouse Storage Schema. Enforce a rule that the Edge Receiver must iterate over the OTLP attributes and flatten them into a simple, flat JSON map (e.g., `{"http.status": 200}`) before putting the data onto the `logs-raw` topic.

## Decision
We will strictly enforce **Attribute Flattening at the Edge Receiver**. Raw OTLP `KeyValue` arrays will **never** reach ClickHouse or pollute the internal pipeline. 

The Edge Receiver will perform a cheap `O(n)` iteration over incoming attributes, transforming the transport-optimized array into an OLAP-optimized flat JSON/Map payload.

## Consequences
- **Positive**: Dramatically simplifies downstream processing for the Normalization Workers and the AI Consumers.
- **Positive**: Makes ClickHouse JSON queries incredibly fast and ergonomic. Engineers can write simple queries like `SELECT * FROM logs WHERE attributes['http.status'] = 200`, which utilize ClickHouse's native bloom filters and execute in milliseconds.
- **Negative**: The Edge Receiver must expend extra CPU cycles to unpack, iterate, and reconstruct the JSON payloads during high-speed ingestion. However, doing this at the very edge is far cheaper than paying the I/O and CPU penalty on every database read.
