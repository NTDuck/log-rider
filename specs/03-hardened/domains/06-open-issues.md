# Open Issues

1. **Exact PII Scrubbing Rules:** FR-002 specifies that logs are scrubbed, but the exact regexes or fields (e.g., `email`, `ssn`) to strip are not formalized.
2. **Batch Digest Formatting:** NFR-003 and UC-02 mention batch digests as a fallback for Telegram rate limits. The structure and frequency of this digest remain unspecified.
3. **Control Plane Security:** The `/api/v1/config/thresholds` endpoint expects authorization, but the specifics of admin role validation via the JWT aren't explicitly scoped.
4. **ClickHouse Optimize Strategy:** NFR-002 defines TTL but mentions `OPTIMIZE TABLE` during failures. It is unclear if this should be automated or purely manual.
