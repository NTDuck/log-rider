# 0021. Dead Letter Queue for Poison Pills

## Status
Accepted

## Context
In Kafka/Redpanda, unrecoverable errors (like a serialization failure on a malformed payload) typically result in either silent data loss (if the message is ACKed) or infinite partition blocking (if it is NACKed and retried endlessly).

## Decision
All stream consumers must implement a strict Dead Letter Queue (DLQ) pattern. Upon an unrecoverable error, the consumer will wrap the payload and error trace, publish to a `logs-dlq` topic, and immediately ACK the original message.

## Consequences
- **Positive**: Guarantees zero silent data loss while completely preventing infinite retry loops from halting ingestion.
- **Positive**: Engineers can inspect, fix, and replay failed messages from the DLQ out of band.
- **Negative**: Requires additional operational tooling to monitor and replay the DLQ.
