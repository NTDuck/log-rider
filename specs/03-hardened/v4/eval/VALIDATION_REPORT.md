# Architecture Validation Audit Report: v4 Hardened Design

**Auditor Persona**: Systems Performance Engineer
**Target Document**: `specs/03-hardened/v4/README.md`
**Baseline Reference**: `specs/02-disambiguated/README.md`

## 1. Memory Allocations & Resource Safety
* **Edge Receiver Stack/Memory Exhaustion**: `FR-001` mandates the Edge Receiver parse JSON and mechanically unroll nested `kvlists` *before* the nesting depth boundary (max depth = 5) is enforced. An attacker sending a 1MB payload with 10,000 levels of nesting will force the Edge Receiver to recursively parse and unroll the payload, likely causing a stack overflow or massive memory spike. The Edge Receiver is exposed to the exact DoS vectors the Worker is supposed to mitigate.
* **ClickHouse Dictionary Bloat**: The ClickHouse schema uses `LowCardinality(String)` for `app_name` and `error_code`. However, the OpenAPI spec lacks any `maxLength` or format constraints for these fields. A malicious client can pass 999KB unique strings or UUIDs as the `error_code`, which will immediately bloat the ClickHouse dictionary into memory limits and degrade OLAP performance globally.

## 2. Missing Data Boundaries
* **OpenAPI Schema Lack of Limits**: The `IngestedLog` OpenAPI schema defines types but strictly misses boundaries. There are no `maxLength` limits on string properties, and no `maxItems` limits on the `attributes` array. 
* **I/O Boundary Gap (Payload Size)**: The Edge Receiver limits ingress to `1MB`, but the Worker DLQs payloads exceeding `64KB compressed`. This permits up to 1MB of uncompressed malicious/wasteful payload to traverse the network into Redpanda (`logs-raw`), wasting Kafka/Redpanda broker disk and I/O bandwidth before being eventually rejected by the Worker.

## 3. Un-flattened OTLP Transport Payloads vs DB Schema Mismatch
* **Data Shape Misalignment**: `FR-001` specifies that the Edge unrolls `kvlists` into "flat structures" (dot-notation), but the ClickHouse `logs` table contract explicitly expects parallel arrays: `attribute_keys Array(String)` and `attribute_values_string Array(String)`. 
* If the Edge outputs a flat JSON object (e.g., `{"a.b": "value"}`) to `logs-raw`, there is no specified transformation step to un-flatten or extract these keys into the parallel arrays expected by the DB Writer. The payload format is left ambiguous between the Edge and the DB.

## 4. Compliance Against Disambiguated Baseline
### Validation Location Ambiguity (Failed to Resolve)
The `v3` ambiguity remains severe in `v4`. 
* `specs/02-disambiguated` defines the Edge as a "dumb pipe" that offloads CPU-heavy cleaning to the Worker.
* `v4` contradicts this by forcing the Edge Receiver to perform the CPU-heavy flattening and depth calculation, but bizarrely delegates the *rejection* (DLQ routing) to the Worker. This forces the Edge to do the heavy lifting it was supposed to avoid, without granting it the authority to drop Poison Pills early. Depth validation MUST happen during or before the Edge attempts to flatten the payload.

### Homogeneous Arrays Constraint (Failed to Resolve)
* `v4` assigns the Normalization Worker the responsibility of enforcing that arrays do not contain mixed data types. 
* **The Flaw**: The Edge Receiver has *already* flattened the nested payload before sending it to `logs-raw`. The original array structure is therefore destroyed (e.g., converted to flat dot-notation keys like `array.0 = 1`, `array.1 = "two"`). Operating on an already-flattened payload, the Normalization Worker has lost the structural context required to reliably detect or validate standard JSON heterogeneous arrays. Array validation MUST happen before flattening.
