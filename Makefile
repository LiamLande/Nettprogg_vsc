# LiveShare Lite Makefile
# Works on Linux, macOS, and Windows (via WSL, Git Bash, or `choco install make`).
#
# Run `make help` to see every available target.

SHELL := /bin/sh
.DEFAULT_GOAL := help

CRATES_MANIFEST := crates/Cargo.toml
RELAY_PORT      ?= 7071
SIGNALING_PORT  ?= 7072

# Detect the host operating system. `uname` exists on every Unix-like; on
# Windows under PowerShell `uname` is missing and we fall back to "Windows".
UNAME := $(shell uname -s 2>/dev/null || echo Windows)

# ----------------------------------------------------------------------------
# Help
# ----------------------------------------------------------------------------

.PHONY: help
help:  ## Show this help text
	@awk 'BEGIN { FS = ":.*?##"; printf "Usage: make <target>\n\nTargets:\n" } \
	      /^[a-zA-Z0-9_.-]+:.*?##/ { printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

# ----------------------------------------------------------------------------
# Setup
# ----------------------------------------------------------------------------

.PHONY: setup
setup: node_modules build-rust build-wasm build-ts  ## Full one-shot bootstrap of the project

node_modules: package.json
	npm install
	@touch node_modules

.PHONY: ensure-wasm-pack
ensure-wasm-pack:  ## Install wasm-pack if the binary is missing
	@command -v wasm-pack >/dev/null 2>&1 || cargo install wasm-pack

# ----------------------------------------------------------------------------
# Build
# ----------------------------------------------------------------------------

.PHONY: build
build: build-rust build-wasm build-ts  ## Build everything (Rust release + WASM + TypeScript)

.PHONY: build-rust
build-rust:  ## Build the Rust workspace in release mode
	cargo build --release --manifest-path $(CRATES_MANIFEST)

.PHONY: build-wasm
build-wasm: ensure-wasm-pack  ## Build the CRDT WebAssembly bundle into src/wasm/crdt
	wasm-pack build crates/crdt-wasm --target nodejs --out-dir ../../src/wasm/crdt

.PHONY: build-ts
build-ts:  ## Compile the TypeScript extension into dist/
	npm run compile

# ----------------------------------------------------------------------------
# Tests
# ----------------------------------------------------------------------------

.PHONY: test
test: test-rust test-ts  ## Run every test suite (Rust + vitest)

.PHONY: test-rust
test-rust:  ## Run cargo tests (CRDT, protocol, relay, signaling)
	cargo test --manifest-path $(CRATES_MANIFEST)

.PHONY: test-ts
test-ts:  ## Run vitest packaging test
	npm test

.PHONY: lint
lint:  ## Run cargo fmt check + clippy with -D warnings
	cargo fmt --manifest-path $(CRATES_MANIFEST) --all -- --check
	cargo clippy --manifest-path $(CRATES_MANIFEST) --all-targets -- -D warnings

# ----------------------------------------------------------------------------
# Run
# ----------------------------------------------------------------------------

.PHONY: run-relay
run-relay:  ## Run the relay server in the foreground
	HOST=127.0.0.1 PORT=$(RELAY_PORT) cargo run --release --manifest-path $(CRATES_MANIFEST) --bin relay-server

.PHONY: run-signaling
run-signaling:  ## Run the signaling server in the foreground
	HOST=127.0.0.1 PORT=$(SIGNALING_PORT) cargo run --release --manifest-path $(CRATES_MANIFEST) --bin signaling-server

.PHONY: free-ports
free-ports:  ## Kill any process holding the relay or signaling port
ifeq ($(UNAME),Linux)
	-@if command -v fuser >/dev/null 2>&1; then \
	    fuser -k $(RELAY_PORT)/tcp 2>/dev/null || true; \
	    fuser -k $(SIGNALING_PORT)/tcp 2>/dev/null || true; \
	 elif command -v lsof >/dev/null 2>&1; then \
	    lsof -ti tcp:$(RELAY_PORT)     | xargs -r kill -9 2>/dev/null || true; \
	    lsof -ti tcp:$(SIGNALING_PORT) | xargs -r kill -9 2>/dev/null || true; \
	 fi
	@echo "Ports $(RELAY_PORT) and $(SIGNALING_PORT) freed (if anything was listening)."
else ifeq ($(UNAME),Darwin)
	-@lsof -ti tcp:$(RELAY_PORT)     | xargs kill -9 2>/dev/null || true
	-@lsof -ti tcp:$(SIGNALING_PORT) | xargs kill -9 2>/dev/null || true
	@echo "Ports $(RELAY_PORT) and $(SIGNALING_PORT) freed (if anything was listening)."
else
	@echo "Windows: freeing ports requires PowerShell. Run:"
	@echo "  powershell -Command \"Get-NetTCPConnection -LocalPort $(RELAY_PORT)     -ErrorAction SilentlyContinue | %% { Stop-Process -Id \$$_.OwningProcess -Force }\""
	@echo "  powershell -Command \"Get-NetTCPConnection -LocalPort $(SIGNALING_PORT) -ErrorAction SilentlyContinue | %% { Stop-Process -Id \$$_.OwningProcess -Force }\""
endif

# ----------------------------------------------------------------------------
# Docker
# ----------------------------------------------------------------------------

.PHONY: docker-build
docker-build:  ## Build the relay + signaling Docker image
	docker compose build

.PHONY: docker-up
docker-up:  ## Start the relay and signaling servers in containers
	docker compose up -d
	@echo "Relay     listening on ws://localhost:$(RELAY_PORT)"
	@echo "Signaling listening on ws://localhost:$(SIGNALING_PORT)"

.PHONY: docker-down
docker-down:  ## Stop the relay and signaling containers
	docker compose down

.PHONY: docker-logs
docker-logs:  ## Tail container logs
	docker compose logs -f

.PHONY: docker-rebuild
docker-rebuild:  ## Rebuild and restart the containers
	docker compose down
	docker compose up -d --build

# ----------------------------------------------------------------------------
# Cleanup
# ----------------------------------------------------------------------------

.PHONY: clean
clean:  ## Remove all build artefacts (node_modules, dist, target, src/wasm)
	rm -rf node_modules dist src/wasm
	cargo clean --manifest-path $(CRATES_MANIFEST)

.PHONY: clean-rust
clean-rust:  ## Remove Rust build artefacts
	cargo clean --manifest-path $(CRATES_MANIFEST)

.PHONY: clean-ts
clean-ts:  ## Remove TypeScript build artefacts
	rm -rf dist src/wasm

.PHONY: distclean
distclean: clean docker-down  ## Full reset: artefacts + node_modules + containers
	-docker compose rm -f 2>/dev/null || true
	-rm -rf node_modules
