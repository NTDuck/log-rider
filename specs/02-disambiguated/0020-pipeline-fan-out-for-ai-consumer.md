# 0020. Pipeline Fan-Out for AI Consumer

## Status
Accepted

## Context
A "Bonus Point" requirement is to provide AI-powered log analysis and classification. We need an **AI Consumer** to run machine learning inference (via small HuggingFace models) to automatically tag logs with categories or anomaly scores. 

The challenge lies in where to attach this AI workload within the data pipeline to ensure it has clean data but does not block high-speed database ingestion.

## Alternatives Considered & The Debate
We debated exactly what stream of data the AI Consumer should read and process.

1. **Read from `logs-raw` (Rejected)**
   The AI Consumer reads un-normalized logs directly from the Edge Receiver.
   *Why it was rejected:* Un-normalized data is dangerous. If the Normalization rules strip PII (like credit card numbers) or reformat fields, reading from `logs-raw` means the AI model is analyzing raw, potentially sensitive, non-compliant data.

2. **Read from `log-status` Delta Updates (Rejected)**
   The AI Consumer listens to the state tracking topic for "processed" events.
   *Why it was rejected:* In ADR-0015, we mandated Delta Updates on `log-status`. Those messages have no payload! The AI Consumer would be forced to maintain a complex, stateful stream materializer in memory to rebuild the log payload, risking massive memory leaks.

3. **Inline before DB Writer (Rejected)**
   The Worker runs normalization, passes it to AI, then passes it to DB.
   *Why it was rejected:* Blocks pure network I/O writes behind GPU/CPU inference latency.

4. **Multi-Topic Topology / Fan-Out (Accepted)**
   Create a pure, reactive data pipeline. The Edge Receiver publishes to `logs-raw`. The Normalization Worker reads that, cleans it, and publishes to a new topic: `logs-normalized`. The pipeline then *fans out*: The DB Writer and the AI Consumer act as independent consumer groups reading the exact same `logs-normalized` stream in parallel. 

## Decision
We will implement a **Multi-Topic Topology** to enforce Pipeline Fan-Out. 
- The DB Writer will read from `logs-normalized` to execute pure network I/O batch inserts into ClickHouse.
- In parallel, the AI Consumer will independently read from `logs-normalized`, get perfectly cleaned and scrubbed payloads without tracking state, run its GPU/CPU inference, and write its output tags asynchronously to the `log_ai_tags` sidecar table.

## Consequences
- **Positive**: Completely decouples CPU-heavy workloads (Normalization), pure network I/O (DB Writer), and GPU/CPU inference (AI Consumer). 
- **Positive**: Downstream consumers can scale completely independently based on their bottlenecks.
- **Positive**: The AI Consumer operates out-of-band and cannot slow down the critical ingestion-to-storage pipeline, while guaranteeing it never analyzes un-scrubbed PII.
- **Negative**: Requires maintaining an additional Kafka/Redpanda topic (`logs-normalized`), slightly increasing broker disk usage.
