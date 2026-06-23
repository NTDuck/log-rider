# 0016. Single Multi-Call Binary Across Containers

## Status
Accepted

## Context
The system architecture has evolved into multiple distinct components: the Edge Receiver, the Normalization Worker, the DB Writer, the AI Consumer, and the Alert Consumer. All are highly performant Rust services. The original requirements specifically mandate that the system must be "packageable and deployable using Docker... including Backend, DB, Message Queue, and Redis Cache." Note the singular word "Backend."

Managing separate codebases, repositories, and Dockerfiles for each of these microservices introduces significant operational overhead, slower build times, and the risk of shared domain logic drifting out of sync.

## Alternatives Considered & The Debate
During the design review, we debated how to package and deploy these services.

1. **Standard Microservices with Separate Containers (Rejected)**
   Each service has its own repository/workspace, its own Dockerfile, and produces its own Docker image.
   *Why it was rejected:* This approach fractures domain models and requires publishing internal crates or duplicating code. Operationally, running `docker-compose build` would attempt to compile Rust from scratch five times, taking ~30 minutes on a standard laptop. Granular deployments in a shared domain are largely an illusion because changing shared domain logic (like a core struct) forces rebuilding everything anyway. Furthermore, running five separate Rust OS-level containers might choke the Docker engine networking during the required 2-second high-speed simulation.

2. **All-in-One Monolithic Container (Rejected)**
   Compile everything together and run all services concurrently inside a single Docker container using a process manager.
   *Why it was rejected:* This represents a fundamental operational misunderstanding. It destroys failure isolation and independent scalability. If the AI Consumer crashes, it could take down the DB Writer. If the Normalization Worker needs 10x the CPU of the Alert Consumer, we can't scale them independently.

3. **Single Multi-call Binary Across Isolated Containers (Accepted)**
   Structure the Rust codebase as a **Modular Monolith inside a single Cargo Workspace**. Create a `libs/` folder for shared domain logic and an `apps/` folder for the 5 services. Compile everything into a single, blazing-fast multi-call binary and bake it into exactly one Docker image. Deploy that identical image as 5 completely isolated containers, using command-line overrides (e.g., `--role receiver`, `./log_system run worker`) to define each container's role at startup.

## Decision
We commit to the **Modular Monolith** and will compile all Rust services into a **Single Multi-Call Binary**. In production, this single Docker image will be deployed as independently scalable, isolated containers using role-based `CMD` entrypoint flags.

## Consequences
- **Positive**: Tremendously simplifies the CI/CD pipeline. Compile once, deploy everywhere. There is only one build process and one Docker image to test and push, accelerating deployment speed.
- **Positive**: Shared code (models, policies, utility functions) is inherently synchronized across all services, eliminating version drift.
- **Positive**: Best of both worlds: monolith build efficiency with the absolute failure isolation and independent resource scaling of a true microservice architecture.
- **Negative**: The binary size is slightly larger as it contains the code for all services, but this is operationally negligible in a containerized environment.
- **Negative**: We lose granular deployments (deploy one, deploy all), but this is an acceptable trade-off since shared domain logic changes would require full rebuilds regardless.
