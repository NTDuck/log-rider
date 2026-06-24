# Build Stage
FROM rust:bookworm AS builder
WORKDIR /app

# Install build dependencies for rdkafka-sys and reqwest
RUN apt-get update && apt-get install -y pkg-config cmake libssl-dev && rm -rf /var/lib/apt/lists/*

# Copy project files
COPY . .

# Build release
RUN cargo build --release

# Runtime Stage
FROM debian:bookworm-slim
WORKDIR /app

# Install runtime dependencies
RUN apt-get update && apt-get install -y ca-certificates libssl-dev && rm -rf /var/lib/apt/lists/*

# Copy compiled binary
COPY --from=builder /app/target/release/logger /usr/local/bin/logger

ENTRYPOINT ["logger"]
