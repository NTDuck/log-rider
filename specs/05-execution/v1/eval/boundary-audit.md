# Security & Boundary Inspection Report

## 1. Exact file paths/symbols inspected
**Track 1:**
- `specs/05-execution/v1/track-01-edge-receiver-tasks.md` (Tasks B.1, B.2)
- `specs/04-implementation/v10/track-01-edge-receiver.md`
**Track 3 & 7:**
- `specs/05-execution/v1/track-03-db-writer-tasks.md` (Task C.1)
- `specs/05-execution/v1/track-07-admin-api-tasks.md` (Task C.1)
- `specs/04-implementation/v10/track-03-db-writer.md`
- `specs/04-implementation/v10/track-07-admin-api.md`

## 2. Current behavior in the artifacts
- **Track 1:** The Attack Vector instructed to ensure Track 1 requires `WireLog` (accepting unbounded `serde_json::Value`). However, the implementation spec strictly **forbids** `WireLog` and `serde_json::Value` to prevent memory-exhaustion DoS. The execution tasks (`track-01-edge-receiver-tasks.md`) correctly adhere to the spec: they only define `DomainLog` and explicitly mandate a "low-level token pull-parser... BEFORE AST construction." They do *not* require the unsafe `WireLog` model.
- **Track 3 & Track 7:** The v10 implementation specs explicitly forbid ClickHouse `UPDATE` and `DELETE` queries. However, the generated execution tasks in `v1` only request HTTP POST JSONEachRow appenders/writers and **do not explicitly state the negative constraint** forbidding `UPDATE` or `DELETE` mutations.

## 3. Correctness risks
- **Track 1:** Imposing the Attack Vector's requirement (`WireLog` with unbounded `serde_json::Value`) would introduce a critical memory-exhaustion vulnerability (DoS) by violating the system's zero-allocation parsing invariant. The current tasks are correctly safe from this.
- **Tracks 3 & 7:** The omission of explicit negative constraints (forbidding `UPDATE`/`DELETE`) in the execution task files leaves a gap. An AI coder or human developer executing these tasks might unknowingly introduce mutation queries later, violating the immutable append-only database invariant.

## 4. Recommendation: Amend
- **Track 1:** **Pass** the current defensive posture, but **Amend** Task B.1/B.2 to explicitly include the negative constraint from the spec: *"Do NOT implement an intermediate `WireLog` or use `serde_json::Value`."* The Attack Vector's requirement must be rejected as it violates core security invariants.
- **Tracks 3 & 7:** **Amend** Task C.1 in both `track-03-db-writer-tasks.md` and `track-07-admin-api-tasks.md` to explicitly declare: *"ClickHouse `UPDATE` or `DELETE` mutation queries are strictly forbidden."*

## 5. Confidence level
High (100%) - The discrepancy between the v10 specs (which contain explicit negative constraints) and the v1 tasks (which omit them) is clear, and the Attack Vector for Track 1 contradicts the established memory defense invariants.
