Feature: Normalization Worker Processing

  Scenario: Valid log is PII-redacted and normalized
    Given a log message in logs-raw containing PII patterns (e.g., email addresses, credit card numbers)
    When the Normalization Worker consumes and processes it
    Then the worker MUST apply all compiled PII regex patterns to the message field
    And increment logger_pii_redactions_total for each regex hit
    And publish the redacted NormalizedLog to logs-normalized
    And increment logger_events_processed_total with labels stage="normalization" and status="success" exactly once
    And commit the consumer offset only after the produce to logs-normalized returns success

  Scenario: High-priority error is duplicated post-redaction
    Given a log message in logs-raw with level ERROR
    When the Normalization Worker consumes, PII-redacts, and normalizes it
    Then the worker MUST publish the redacted NormalizedLog to logs-normalized
    And MUST publish the same redacted NormalizedLog to alerts-priority-stream
    And commit the consumer offset only after both produces return success

  Scenario: High-priority critical is duplicated post-redaction
    Given a log message in logs-raw with level CRITICAL
    When the Normalization Worker consumes, PII-redacts, and normalizes it
    Then the worker MUST publish the redacted NormalizedLog to logs-normalized
    And MUST publish the same redacted NormalizedLog to alerts-priority-stream
    And commit the consumer offset only after both produces return success

  Scenario: Poison pill exceeding 64KB is routed to DLQ
    Given a raw payload in logs-raw whose compressed size exceeds 64KB
    When the Normalization Worker detects the size violation
    Then it MUST construct a DLQEnvelope with truncated payload, hash, reason, worker_id, and timestamp
    And publish the DLQEnvelope to logs-dlq
    And increment logger_dlq_routed_total
    And increment logger_events_processed_total with labels stage="normalization" and status="error" exactly once
    And commit the consumer offset after the DLQ produce returns success

  Scenario: Structurally undeserializable payload is routed to DLQ
    Given a raw payload in logs-raw that is valid in size but fails JSON deserialization
    When the Normalization Worker attempts to parse it
    Then it MUST construct a DLQEnvelope with the truncated payload and hash
    And publish to logs-dlq
    And increment logger_dlq_routed_total
    And increment logger_events_processed_total with labels stage="normalization" and status="error" exactly once
