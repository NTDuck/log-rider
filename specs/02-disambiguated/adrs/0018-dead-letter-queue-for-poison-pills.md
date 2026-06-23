# 0018. Dead Letter Queue for Poison Pills

## Status
Accepted

## Context
In a high-speed messaging pipeline backed by Kafka/Redpanda, components like the Normalization Worker, DB Writer, AI Consumer, and Alert Consumer are constantly polling and processing streams. 

The ultimate disaster recovery scenario involves a rogue client application sending a maliciously crafted log payload. The Receiver accepts and pushes it to `logs-raw`. When the Worker attempts to normalize it, an unexpected data type causes an unrecoverable serialization error. These are "poison pills," and we must decide how the system reacts to these fatal edge cases.

## Alternatives Considered & The Debate
Handling poison pills improperly in streaming systems leads to catastrophic failure modes.

1. **Acknowledge and Drop (Rejected)**
   The consumer catches the error, logs it to `stdout`, and ACKs the message to move on.
   *Why it was rejected:* This results in silent data loss. The customer's log is gone forever, the business has no idea it was dropped, and there is no way to recover or inspect the failure later.

2. **Negative Acknowledge / Endless Retry (Rejected)**
   The consumer throws an error, NACKs the message, and lets the consumer loop retry.
   *Why it was rejected:* Because the error is unrecoverable (e.g., malformed JSON/unexpected data type), retrying will fail every single time. Because Kafka guarantees partition ordering, that single bad log blocks the entire partition. Millions of healthy logs will pile up behind the poison pill, infinitely retrying thousands of times per second until the disk fills up and the ingestion pipeline completely crashes.

3. **Strict Dead Letter Queue (DLQ) Protocol (Accepted)**
   Treat processing as fallible. Provide an explicit escape hatch for bad payloads so partitions remain unblocked and no data is silently lost.

## Decision
We mandate a strict **Dead Letter Queue (DLQ)** routing protocol for all stream consumers (Worker, DB Writer, AI Consumer, Alert Consumer). 

If an unrecoverable error occurs during processing, the consumer MUST:
1. Wrap the original, failing payload in a new JSON object alongside the exact error stack trace or failure reason.
2. Publish that wrapped message to a dedicated Redpanda topic called `logs-dlq`.
3. Instantly **ACK** the original message to keep the main partition moving.

## Consequences
- **Positive**: Guarantees zero silent data loss.
- **Positive**: Completely prevents infinite retry loops, ensuring that a single bad log cannot halt the entire ingestion pipeline. The system elegantly sidelines the failure and keeps processing the thousands of healthy logs right behind it.
- **Positive**: System Administrators or developers can inspect the `logs-dlq` topic out-of-band, fix the underlying Rust bugs, and easily replay the failed messages back into the pipeline once resolved.
- **Negative**: Requires additional operational tooling and monitoring to alert the team when the DLQ topic size grows.
