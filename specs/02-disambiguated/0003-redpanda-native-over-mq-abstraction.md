# 0003. Redpanda Native Over MQ Abstraction

## Status
Accepted

## Context
To handle the high-speed ingestion API (receiving continuous logs from other software), the system requires a Message Queue acting as a shock absorber. Without a buffer, executing direct database insertions for every incoming log would instantly overload the system.

During the design phase, the engineering plan proposed abstracting the message broker behind a generic trait (e.g., `Trait MessageQueue`). The intention was to allow the underlying broker to be parameterised and swapped out (cold) between technologies like Redis Streams, Kafka, or RabbitMQ based on future needs.

However, abstracting message brokers behind a generic interface is historically a dangerous architectural trap. Brokers like Kafka, RabbitMQ, and Redis Streams possess fundamentally different delivery guarantees, scaling models, and consumer behaviors:
- **Kafka** relies on partitions and offset tracking, making it perfect for high-throughput, horizontally scalable log ingestion.
- **RabbitMQ** utilizes complex routing keys, exchanges, and transient queues, optimized for complex message routing rather than raw throughput.
- **Redis Streams** uses consumer groups but is fundamentally bound by in-memory constraints.

By building a generic abstraction layer, the system would be forced to design for the lowest common denominator. It would be impossible to utilize Kafka's powerful partition-based ordering or RabbitMQ's precise routing because the generic trait could not safely support them all. For a system processing hundreds or thousands of logs per second, winning on performance requires leveraging the specific tuning of a dedicated broker's client.

## Decision
We will **drop the swappable message queue abstraction** entirely. We commit to using **Redpanda** (a lightweight, drop-in Rust-native replacement for Kafka) as our absolute, singular message broker for the ingestion pipeline.

## Alternatives Considered
- **Generic `Trait MessageQueue` Abstraction**: Rejected. Forces lowest-common-denominator design, preventing the use of broker-specific high-throughput features. Burns engineering hours building an interface that will likely leak abstractions anyway.
- **RabbitMQ**: Rejected. While excellent for complex routing, it is not optimized for the raw, append-only, high-throughput stream processing required for massive log ingestion.
- **Redis Streams**: Rejected. Memory-bound and lacks the robust partition scaling required for an enterprise log ingestion pipeline.
- **Apache Kafka (JVM)**: Considered, but Redpanda was chosen instead. Redpanda provides the exact same Kafka API and consumer group semantics without the heavy JVM overhead, pairing perfectly with our high-performance Rust stack.

## Consequences
- **Positive**: We can natively leverage Kafka's unparalleled throughput, partition-based ordering, and consumer group semantics, allowing our Rust workers to horizontally scale safely.
- **Positive**: Performance tuning can be hyper-optimized for the specific Redpanda Rust client, maximizing ingestion speed.
- **Positive**: Saves significant engineering time that would have been wasted building and maintaining a fragile generic MQ interface.
- **Negative**: Hard vendor lock-in to the Kafka protocol. If the organization ever mandates switching to RabbitMQ or an AWS-native SQS system, it will require a substantial rewrite of the ingestion layer.
