# CSP and Concurrency Auditor Report
**Target:** `specs/04-implementation/v9/*`
**Lenses Applied:** 3 (Cancellation Safety) & 4 (Memory Defense)
**Constraint Enforced:** The DAG-Only Verification Rule

## Lens 3: The Cancellation Safety Inspector (All Tracks)

**DIRECTIVE:** Verify Idempotent Cancellation and Future shielding. Reject `tokio::sync::watch::Receiver`; mandate `tokio_util::sync::CancellationToken`. Ensure explicit bounded-channel task decoupling in Track 1 and Track 6.

### Track 1: Edge Receiver ❌ [REJECTED]
- **Violation (DAG-Only Rule):** Phase 3 completely omits explicit mechanical boundaries for cancellation and timeouts. 
- **Details:** The DAG relies on high-level abstractions like "wrapped in a guaranteed-completion future" (Step 4.7) rather than explicit `CancellationToken` primitives. Furthermore, the `TimeoutLayer` boundary instruction is completely absent from Phase 3, improperly deferred to Phase 4 (Monolith Integration). Under the zero-tolerance DAG-only rule, deferring mechanical concurrency primitives to the wiring phase is a structural failure. 

### Track 2: Normalization Worker ✅ [PASSED]
- **Details:** Phase 3 correctly and explicitly mandates `tokio_util::sync::CancellationToken` for both Fetcher and Processor tasks (Step 5) to enforce idempotent shutdown. `watch::Receiver` is absent.

### Track 3: DB Writer ✅ [PASSED]
- **Details:** Phase 3 explicitly injects `cancel_token: CancellationToken` into the async function signatures for both `run_fetcher_task` and `run_processor_task`.

### Track 4: AI Consumer ✅ [PASSED]
- **Details:** Phase 3 explicitly instructs passing `CancellationToken` to the AI consumer loop and correctly selects against it during retry sleeps.

### Track 5: Alert Consumer ✅ [PASSED]
- **Details:** Phase 3 mechanically explicitly requires inner and outer loops to `tokio::select!` on `CancellationToken::cancelled()`.

### Track 6: WebSocket Server ✅ [PASSED]
- **Details:** Phase 3 explicitly integrates `tokio_util::sync::CancellationToken` into both the `session_loop` and `ingestion_loop`. Critically, it does **not** wrap `ws.send().await` in `tokio::time::timeout`. Instead, Phase 3 explicitly decouples the WebSocket sink into a dedicated Egress Task, exclusively using `mpsc` bounded channel capacity (`.try_send()` returning `Full`) to accurately detect and sever lagging clients without leaking futures.

### Track 7: Admin API ✅ [PASSED]
- **Details:** Phase 3 strictly mandates that `tokio_util::sync::CancellationToken` be polled recursively inside internal retry loops, explicitly forbidding `tokio::sync::watch::Receiver` to prevent deadlocks.

---

## Lens 4: The Memory Defense Auditor (Track 1)

**DIRECTIVE:** Verify pure token-stream parsing without intermediate AST memory allocations.

### Track 1: Edge Receiver ✅ [PASSED]
- **Details:** Phase 3 strictly enforces the zero-allocation directive. Step 2.1 explicitly eradicates `serde_json::Value` and `into_iter::<Value>()`. It explicitly mandates a low-level token pull-parser (e.g., `struson` or byte-scanner) to count `{` and `[` tokens directly from the byte stream, hard-aborting before any memory allocation occurs if the nested depth exceeds 5.

---

## AUDITOR CONCLUSION
**Track 1 MUST be rewritten.** Its DAG (Phase 3) fails Lens 3 by illegally abstracting away its concurrency primitives (`TimeoutLayer` boundaries and `CancellationToken` integration) into the forbidden Wiring section (Phase 4). All other tracks mechanically pass the CSP and Memory Defense audits.
