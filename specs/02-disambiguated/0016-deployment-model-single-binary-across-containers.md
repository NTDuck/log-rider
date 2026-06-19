# 0016. Single Multi-Call Binary Across Containers

## Status
Accepted

## Context
The architecture consists of multiple distinct Rust services (Receiver, Worker, DB Writer, Alert Consumer). Managing separate codebases and Dockerfiles for each increases CI/CD complexity.

## Decision
We will compile all Rust services into a blazing-fast, single multi-call binary. In production, we will deploy this single binary across isolated Docker containers, using entrypoint flags (e.g., `logger run worker`) to define their role.

## Consequences
- **Positive**: Tremendously simplifies the build pipeline and Docker image management (only one image to build and push).
- **Positive**: Ensures shared code (like models and utility functions) is always perfectly in sync across services.
- **Negative**: The binary size is slightly larger, though negligible in a Docker context.
