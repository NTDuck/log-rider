# 0002. Custom Rust Workers for Ingestion

## Status
Accepted

## Context
The system architecture mandates a "Log Parsing & Filtering Engine Subsystem" where Workers consume raw log data from a Message Queue, clean it, and store it into the database. 

Initially, there was consideration for using off-the-shelf data collectors and integration tools to handle the pipeline. Specifically, the proposed pipeline involved using Telegraf (InfluxData's data collector) to forward metrics to Kafka, which would then stream directly into ClickHouse via its native Kafka engine. Alternatively, some manage the integration with the standard Telegraf SQL output plugin.

However, this off-the-shelf approach presented a major contradiction with the system requirements. If Telegraf and ClickHouse's Kafka engine (or the standard Telegraf SQL output plugin) automatically streamed data directly from the queue to the database, it would completely bypass the need for custom Workers to perform policy-based normalization, character extraction, and dynamic routing (such as instantly forwarding `CRITICAL` or `ERROR` logs to a priority alert queue). 

Standard ecosystem tools like Telegraf, Logstash, or Vector, while easy to set up initially, often become rigid and difficult to configure when highly specific, custom business logic is required in the ingestion path.

## Decision
We will build **Custom Rust Workers** to serve as the processing layer. These custom services will consume raw logs from the message broker, apply our defined normalization policies, and execute manual batch `INSERT` statements into ClickHouse. We explicitly reject the use of off-the-shelf data collectors (like Telegraf or Logstash) and native database Kafka ingestion engines.

## Alternatives Considered
- **Telegraf / Logstash / Vector**: Rejected. While these tools reduce initial boilerplate, they lack the extreme flexibility needed for custom, high-speed routing (e.g., instantly duplicating `CRITICAL` logs to a priority stream) and complex, policy-based normalization without writing convoluted plugin code.
- **ClickHouse Native Kafka Engine**: Rejected. This would consume directly from Kafka into the database, entirely skipping the required worker processing layer and making it impossible to intercept and route high-priority alerts *before* they hit the database.

## Consequences
- **Positive**: We gain absolute, granular control over batching semantics, memory allocation, and custom routing logic.
- **Positive**: The Rust workers act as a dedicated normalization layer, perfectly suited for enforcing strict schema policies and cleaning data before it pollutes the ClickHouse database.
- **Positive**: Allows for seamless integration with our custom event-driven alerting pipeline, as the worker can identify `ERROR` logs in-memory and instantly duplicate them to an alert stream.
- **Negative**: Represents a significant engineering investment. Hand-rolling a high-speed ingestion pipeline from scratch increases development time, testing requirements, and maintenance burden compared to simply configuring a YAML file for an off-the-shelf collector.
