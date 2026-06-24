# Build Stage
FROM ubuntu:24.04 AS builder
WORKDIR /app

ENV DEBIAN_FRONTEND=noninteractive
# Install build dependencies for rdkafka-sys, reqwest, and rustup
RUN apt-get update && apt-get install -y curl pkg-config cmake libssl-dev build-essential && rm -rf /var/lib/apt/lists/*

# Install Rust
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
ENV PATH="/root/.cargo/bin:${PATH}"

# Copy project files
COPY . .

# Build release
RUN cargo build --release

# Runtime Stage
FROM ubuntu:24.04
WORKDIR /app

# Install runtime dependencies
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y ca-certificates libssl-dev && rm -rf /var/lib/apt/lists/*

# Copy compiled binary
COPY --from=builder /app/target/release/logger /usr/local/bin/logger

ENTRYPOINT ["logger"]
