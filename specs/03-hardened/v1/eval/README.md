# Council Validation Audit Report (Round 2)

**Status**: ❌ **REJECTED**
**Artifact**: `specs/03-hardened/v1/README.md`

## 1. Skeptic Architect Findings
- **Result**: PASS (100% clean approval)
- **Notes**: All microservice bloat, implicit relational logic, generic MQ abstractions, and `UPDATE`/`DELETE` queries have been successfully eradicated.

## 2. Security & Compliance Officer Findings
- **Violation (PII Containment Logic Flaw)**: The document conflates payload shape validation with PII containment in FR-002 and ignores the residual risk of PII entering `logs-raw` if the Client SDK fails.
- **Fix Required**: Explicitly acknowledge the residual risk that `logs-raw` may store unredacted PII if the client fails. Re-assign server-side PII containment to explicit regex redaction within the Normalization Worker as a defense-in-depth measure, and enforce strict short retention on `logs-raw`.

## 3. Systems Performance Engineer Findings
- **Violation (Edge Receiver OOM Vulnerability)**: The Edge Receiver lacks a pre-parsing connection-level size boundary.
- **Fix Required**: Enforce a strict connection-level payload size limit (e.g., 1MB) at the Edge Receiver before JSON/OTLP parsing occurs to prevent stack overflow.
- **Violation (Alert Deduplication Unbounded Cardinality)**: The Redis tumbling window lacks a memory boundary for unique fingerprints.
- **Fix Required**: Define a strict max cardinality cap (e.g., 10,000 fingerprints) per 60-second window in Redis.
- **Violation (ClickHouse Schema Mismatch)**: Arrays/ints resulting from Edge flattening will crash when inserted into ClickHouse's `Map(String, String)`.
- **Fix Required**: Specify that the DB Writer must serialize all attribute values into JSON strings before DB insertion.
- **Violation (Un-flattened Proxy Contradiction)**: FR-001 commands the Edge to proxy "raw" payloads, contradicting the flattening rule.
- **Fix Required**: Replace "raw payloads" with "flattened payloads" in FR-001.

## Next Steps
The agent must apply this feedback as a final prompt patch, rewrite `03-hardened.md`, and resubmit for what should be the final council approval.
