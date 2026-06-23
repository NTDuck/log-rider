# 0020. Concrete SoA over Clean Architecture

## Status
Accepted

## Context
Our initial conventions enforced strict Clean Architecture and Domain-Driven Design with global layers. However, pure Clean Architecture hides implementation-specific details that the system heavily depends on (e.g., specific batching features in ClickHouse or exact offset behaviors in Redpanda). Attempting to abstract these behind pure global boundaries resulted in leaky abstractions and lost leverage over our tech stack.

## Decision
We will transition to a **Concrete Service-Oriented Architecture (SoA)**. We will group code by concrete bounded contexts (services). Abstractions such as traits and higher-ranked trait bounds (HRTB) will be defined **locally** within a service to facilitate testing without enforcing sweeping, pure-domain global layers.

## Consequences
- **Pros**: Direct access to powerful infrastructure features; simpler repository layout; eliminates "leaky abstractions."
- **Cons**: Tighter coupling to infrastructure choices (Redpanda, ClickHouse); local trait definitions may lead to minor adapter duplication; testing requires careful local boundaries to avoid spinning up full infrastructure for unit tests.
