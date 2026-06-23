# 0020. Multi-Topic Topology for Data Fan-Out

## Status
Accepted

## Context
A "Bonus Point" requirement is to provide AI-powered log analysis and classification. We need an **AI Consumer** to run machine learning inference (via small HuggingFace models) to automatically tag logs with categories or anomaly scores. 

The challenge lies in where to attach this AI workload within the data pipeline. In previous ADRs, we enforced Delta Updates on the `log-status` topic (meaning those events contain no log payload), and we acknowledged that raw ingestion data may contain sensitive PII.

## Alternatives Considered & The Debate
We debated exactly what stream of data the AI Consumer and the Database Writer should read.

1. **Read from `logs-raw` (Rejected)**
   The AI Consumer reads un-normalized logs directly from the Edge Receiver.
   *Why it was rejected:* Un-normalized data is dangerous. If the Normalization rules strip PII (like credit card numbers) or reformat fields, reading from `logs-raw` means the AI model is analyzing raw, potentially sensitive, non-compliant data.

2. **Read from `log-status` Delta Updates (Rejected)**
   The AI Consumer waits for the "processed" event on the state topic.
   *Why it was rejected:* Delta Updates have no payload. The AI Consumer would be forced to maintain a complex, stateful stream materializer in memory to rebuild the full log payload before running inference, risking massive memory leaks.

3. **Inline Worker Processing (Rejected)**
   The Worker runs normalization, runs AI inference inline, and then bulk-inserts to the DB.
   *Why it was rejected:* This combines completely different workloads. It blocks pure network I/O writes behind GPU/CPU inference latency, creating a monolithic bottleneck.

4. **Multi-Topic Topology / Fan-Out (Accepted)**
   Formally split the ingestion pipeline. Create a `logs-normalized` topic. The Worker does nothing but pure CPU computation (stripping PII, cleaning data) and writes to `logs-normalized`. The pipeline then *fans out* to independent, stateless consumers.

## Decision
We will implement a **Multi-Topic Topology** to enforce Pipeline Fan-Out and separate computation from I/O.
- **The Computation**: The Normalization Worker consumes `logs-raw`, cleans the data, and publishes to `logs-normalized`.
- **The DB Writer**: A dumb, high-speed service reads from `logs-normalized` to execute pure network I/O batch inserts into ClickHouse.
- **The AI Consumer**: Independently reads from `logs-normalized`, gets perfectly cleaned and scrubbed payloads without tracking stream state, runs its pure GPU/CPU inference, and writes its output asynchronously to the `log_ai_tags` sidecar table.

## Consequences
- **Positive**: Completely decouples CPU-heavy workloads (Normalization), pure network I/O (DB Writer), and GPU/CPU inference (AI Consumer), allowing them to scale independently based on their specific bottlenecks.
- **Positive**: Downstream services can act as dumb, fast pipes consuming perfectly clean data without building complex stream states or processing un-scrubbed PII.
- **Negative**: Requires maintaining an additional Redpanda topic (`logs-normalized`), slightly increasing broker disk usage.
