# 0005. Strict Schema Policies on Attributes

## Status
Accepted

## Context
Supporting structured logging means accepting dynamic JSON payloads in the `Attributes` field. Without guardrails, malicious or poorly configured clients could send massively nested or oversized JSON, melting down the ClickHouse indexing engine.

## Decision
We will enforce strict Schema Policies at the ingestion stage: max nesting depth of 5, a 64KB byte size limit, homogenous arrays only, and no dots allowed in keys.

## Consequences
- **Positive**: Protects the ClickHouse cluster from out-of-memory errors and unpredictable schema explosions.
- **Negative**: Clients are constrained; oversized logs (like 5MB stack traces) must be manually routed to an `exception_blob` field rather than arbitrary structured attributes.
