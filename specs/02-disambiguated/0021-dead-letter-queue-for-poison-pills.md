# 0021. Dead Letter Queue for Poison Pills

## Status
Accepted

## Context
In a high-speed messaging pipeline backed by Kafka/Redpanda, components like the Normalization Worker, DB Writer, AI Consumer, and Alert Consumer are constantly polling and processing streams. 

Occasionally, they will encounter unrecoverable errors: a serialization failure on a malformed JSON payload, a fundamentally corrupted log, or a normalization crash. We refer to these as "poison pills." We must decide how the system reacts to these errors.

## Alternatives Considered & The Debate
Handling poison pills improperly in streaming systems leads to catastrophic failure modes.

1. **Acknowledge and Drop (Rejected)**
   The consumer catches the error, logs it to `stdout`, and ACKs the message to move on.
   *Why it was rejected:* This results in silent data loss. The business has no idea a log was dropped, and there is no way to recover or inspect the failure later.

2. **Negative Acknowledge / Endless Retry (Rejected)**
   The consumer crashes or NACKs the message, attempting to process it again on the next loop.
   *Why it was rejected:* Since the error is unrecoverable (e.g., malformed JSON), retrying will fail every single time. This creates an infinite retry loop that permanently blocks the Redpanda partition. All subsequent healthy logs queue up behind the poison pill, bringing ingestion to a complete halt.

3. **Strict Dead Letter Queue (DLQ) Protocol (Accepted)**
   Treat processing as fallible. Provide an escape hatch for bad payloads so partitions remain unblocked and no data is silently lost.

## Decision
We mandate a strict **Dead Letter Queue (DLQ)** routing protocol for all stream consumers. 

If an unrecoverable error occurs during processing, the consumer MUST:
1. Wrap the original raw payload together with the error stack trace or failure reason.
2. Publish that wrapped message to a dedicated Redpanda topic called `logs-dlq`.
3. Immediately ACK the original message to unblock the main partition.

## Consequences
- **Positive**: Guarantees zero silent data loss.
- **Positive**: Completely prevents infinite retry loops, ensuring that a single bad log cannot halt the entire ingestion pipeline. Main partitions stay flowing smoothly.
- **Positive**: System Administrators or developers can inspect the `logs-dlq` topic out-of-band, fix the underlying Rust bugs, and easily replay the failed messages back into the pipeline once resolved.
- **Negative**: Requires additional operational tooling and monitoring to alert the team when the DLQ topic size grows, indicating a recurring bug or systemic payload mismatch.
