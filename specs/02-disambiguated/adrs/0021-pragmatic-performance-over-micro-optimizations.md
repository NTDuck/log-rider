# 0021. Pragmatic Performance over Micro-Optimizations

## Status
Accepted

## Context
There was a push to maximize performance by universally replacing `String` with `Cow<'static, str>`, avoiding `.clone()`, and replacing `Arc` with `Rc` where atomic synchronization seemed unnecessary. However, the council identified severe architectural risks with this approach in a multi-core async Rust environment.

## Decision
1. **Concurrency**: We will default to `Arc` for shared architectural dependencies. While `Rc` saves atomic increment overhead, it is `!Send`. Using `Rc` breaks `tokio::spawn` and forces the application into a single-threaded runtime (`current_thread`), sacrificing multi-core work-stealing. `Rc` is strictly reserved for purely synchronous, tightly scoped local algorithms.
2. **Allocations**: We will use standard `String` and owned data as the default. `Cow` and zero-copy borrowing will be reserved explicitly for high-throughput hot paths (e.g., initial payload parsing at the Edge Receiver).
3. **Cloning**: Cloning small data structures is explicitly permitted when it drastically simplifies lifetimes, avoiding the overhead of lifetime contagion or heap-allocated reference counting (`Arc`).

## Consequences
- **Pros**: Maintains compatibility with Tokio's multi-threaded work-stealing executor; drastically improves developer ergonomics; avoids deceptive branch-prediction overhead from overused `Cow` enums.
- **Cons**: Minor atomic increment overhead across service boundaries, which is heavily outweighed by the throughput gains of parallel execution.
