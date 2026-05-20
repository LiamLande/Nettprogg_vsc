# syntax=docker/dockerfile:1.7

# -----------------------------------------------------------------------------
# Stage 1: build the Rust binaries (relay-server + signaling-server)
# -----------------------------------------------------------------------------
FROM rust:1.83-slim-bookworm AS builder

WORKDIR /build

# Install the small set of system libraries the standard Rust deps need.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        pkg-config \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Copy the workspace and build both binaries in one cargo invocation so the
# release profile and dependency graph are shared.
COPY crates ./crates
WORKDIR /build/crates
RUN cargo build --release --bin relay-server --bin signaling-server

# -----------------------------------------------------------------------------
# Stage 2: minimal runtime image with both binaries
# -----------------------------------------------------------------------------
FROM debian:bookworm-slim AS runtime

# CA certificates are useful if the operator wires the server up behind TLS
# or fetches updates; libgcc is implicitly required by the Rust binaries.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system app \
    && useradd  --system --gid app --create-home --home-dir /app app

WORKDIR /app

COPY --from=builder /build/crates/target/release/relay-server     /usr/local/bin/relay-server
COPY --from=builder /build/crates/target/release/signaling-server /usr/local/bin/signaling-server

# Run as a non-root user. The binaries bind on $HOST:$PORT so listening on a
# privileged port is never needed in this image.
USER app

# By default we bind on every interface inside the container so the host can
# reach the published port. The compose file pins HOST=0.0.0.0 explicitly.
ENV HOST=0.0.0.0 \
    PORT=7071 \
    RUST_LOG=info

EXPOSE 7071 7072

# Default to the relay server; docker-compose overrides this for the signaling
# service. `docker run liveshare-lite` therefore brings up a relay.
ENTRYPOINT ["/usr/local/bin/relay-server"]
