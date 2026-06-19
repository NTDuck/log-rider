# 0003. Redpanda Native Over MQ Abstraction

## Status
Accepted

## Context
The system needs a message broker to buffer high-throughput logs. We initially considered abstracting the message queue behind a generic interface (e.g., `Trait MessageQueue`) to allow swapping between Kafka, RabbitMQ, and Redis Streams.

## Decision
We will drop the swappable abstraction and commit to using Redpanda (Kafka-compatible) as the native message broker.

## Consequences
- **Positive**: We can leverage native high-throughput features like partition-based ordering and consumer group semantics without being limited to the lowest common denominator.
- **Positive**: Performance tuning can be hyper-optimized for Redpanda.
- **Negative**: Hard vendor lock-in to the Kafka protocol; switching to RabbitMQ or Redis Streams later would require significant rewrite of the ingestion layer.
