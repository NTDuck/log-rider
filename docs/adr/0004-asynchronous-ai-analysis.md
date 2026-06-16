# 0004. Asynchronous AI Analysis Pipeline

## Status
Accepted

## Context
The system requires AI capabilities to analyze and classify incoming logs, particularly errors. However, AI inference introduces massive latency (seconds per request) compared to the ingestion pipeline (hundreds of logs per second). Running AI on the hot path would cause catastrophic backpressure and crash the ingestion layer.

## Decision
We will isolate AI processing entirely using a two-tiered asynchronous approach:

1. **Lightweight Asynchronous Classification:**
   - The main ingestion Worker will push all `ERROR` and `CRITICAL` logs into a dedicated Redis Stream: `logs:for_ai`.
   - To prevent unbounded growth and ensure insights are relevant to the *live* dashboard, we will apply a strict `MAXLEN ~ 1000` to this stream.
   - This provides native "Lossy Latest-Only" backpressure. If the AI Worker falls behind during an error storm, Redis automatically evicts the oldest logs in the queue. The AI Worker skips the backlog and only processes the freshest errors, guaranteeing insights are never delayed by hours.
   - The AI Worker performs a fast inference pass to generate classification tags, severity hints, and brief root cause suggestions, writing the results to a separate `log_ai_insights` table in PostgreSQL.

2. **Heavy On-Demand Deep Dive:**
   - For a full, expensive LLM diagnostic report on a specific error, the system relies on user intent.
   - The UI will feature an "Analyze" button next to critical logs, triggering a synchronous API call to perform deep analysis only when requested by an engineer.

## Consequences
- **Positive:** Zero latency impact on the core log ingestion and WebSocket broadcasting pipelines.
- **Positive:** The system degrades gracefully; if the AI service goes down or is overwhelmed, logging continues uninterrupted.
- **Positive:** Provides both immediate, lightweight insights and deep, on-demand diagnostics.
- **Negative:** Adds complexity by introducing a new worker pool and an additional Redis Stream to monitor.
