# 0019. Attribute Flattening at the Edge

## Status
Accepted

## Context
We are supporting structured logging where clients can submit dynamic key-value properties. Often, these logs come in via OTLP (OpenTelemetry Protocol). OTLP natively represents dynamic properties as highly nested `repeated KeyValue` arrays with `AnyValue` unions (e.g., `[{"key": "http.status", "value": {"intValue": 200}}]`).

This structure is highly optimized for network transport efficiency (compact binary over gRPC). However, writing this rigid, nested array schema directly into our storage format is a critical design decision.

## Alternatives Considered & The Debate
During the architecture review, the mapping between the Transport Schema and Storage Schema was heavily scrutinized.

1. **Store Raw OTLP in ClickHouse (Rejected)**
   Pipe the highly nested OTLP `KeyValue` arrays directly into ClickHouse and rely on advanced array-extraction SQL functions during reads.
   *Why it was rejected:* Raw OTLP storage destroys ClickHouse performance. Querying nested arrays requires expensive lambda functions: `arrayExists(x -> x.key = 'http.status' AND x.value = '200', attributes)`. This forces full table scans with complex per-row evaluation, completely bypassing ClickHouse's vectorized execution, bloom filters, and skip indexes. 50ms queries would become 5-10 second queries at scale, bringing the cluster to its knees. OTLP is a Transport Protocol, not a Storage Format.

2. **Attribute Flattening at the Edge (Accepted)**
   Explicitly decouple the Transport Schema from the Storage Schema. The Edge Receiver accepts strict, official OTLP Protobufs, but before putting the data into the pipeline, it performs a cheap `O(n)` iteration over the attributes to flatten them into a standard, single-level Map/JSON dictionary (e.g., `{"http.status": 200}`).

## Decision
We will strictly enforce **Attribute Flattening at the Receiver**. Raw OTLP `KeyValue` arrays will **never** reach ClickHouse or pollute the internal pipeline. This is a non-negotiable architectural invariant.

The Receiver will act as a bilingual translator: accepting highly efficient gRPC OTLP on the wire, but instantly transforming it into an OLAP-optimized flattened Map/JSON payload before publishing to the `logs-raw` Redpanda topic.

## Consequences
- **Positive**: Makes ClickHouse JSON/Map queries incredibly fast. Engineers can write simple queries like `attributes['http.status'] = 200`, which natively leverage ClickHouse bloom filters, secondary indexes, and columnar compression for millisecond responses at petabyte scale.
- **Positive**: Maintains 100% OTLP compatibility for standard clients (Grafana Alloy, OpenTelemetry Collector) while protecting our database read performance.
- **Positive**: The cost of flattening at ingestion is a trivial, one-time `O(n)` CPU operation, which is far cheaper than the catastrophic I/O cost of bad array queries at read time.
