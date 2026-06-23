# 0005. Strict Schema Policies on Attributes

## Status
Accepted

## Context
While the original requirements specified a rigid, text-only log structure (e.g., a simple `Message` field), building a modern logging platform requires robust structured logging. If all contextual data is dumped into a single string field, executing analytical queries (like "Application Health Analytics") or real-time filtering requires expensive regex searches across millions of records.

We decided to add an `Attributes` payload (a JSON or dynamic key-value map) to the standard log structure, capitalizing on ClickHouse's excellent native support for `Map` and `JSON` types. 

However, allowing clients to send arbitrary, unstructured JSON payloads into a high-performance database is extremely dangerous. Without guardrails, a poorly configured client or malicious actor could send a 50-level deep recursive object, arrays with mixed data types, or a 5MB stack trace inside a single attribute. Such payloads would rapidly consume memory, blow up the ClickHouse JSON indexing engine, and potentially melt down the entire database cluster.

## Decision
We will enforce **Strict Schema Policies** at the ingestion stage (within the Rust Workers) for all incoming `Attributes` payloads.

The specific guardrails are:
1. **Nesting Limit**: Nested Maps and Lists are supported up to a strict maximum depth of 5.
2. **Homogenous Arrays**: No mixed types in Lists (e.g., `[1, "foo", true]` is strictly forbidden).
3. **Key Sanitization**: Keys cannot contain dots (`.`) or brackets (`[]`). If a client sends `{"foo.bar": 1}`, the Worker will escape it to `{"foo_bar": 1}` during normalization, as dots are reserved for JSON path traversal.
4. **Payload Size Cap**: The maximum byte size per `Attributes` record is capped at 64KB (compressed).

## Alternatives Considered
- **Unstructured String Logging (Original Spec)**: Rejected. Makes advanced filtering and analytical aggregation computationally expensive and practically impossible at scale.
- **Unrestricted JSON Ingestion**: Rejected. Extremely vulnerable to memory exhaustion and indexing failures in ClickHouse due to schema explosions from dynamic, deeply nested payloads.

## Consequences
- **Positive**: These defensive engineering constraints protect the ClickHouse cluster from out-of-memory errors, unpredictable schema explosions, and catastrophic performance degradation.
- **Positive**: Enforcing homogenous arrays ensures that ClickHouse can efficiently map JSON structures to its underlying columnar storage formats.
- **Negative**: Imposes strict constraints on clients sending logs. If a client legitimately needs to log an oversized payload (like a 5MB stack trace), they must be explicitly instructed to place it in a separate `exception_blob` String column rather than the `Attributes` map.
