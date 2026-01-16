#!/usr/bin/env bash
set -euo pipefail
# Fixed 'account already in use' errors by killing the validator and removing the test ledger

# This script ensures a clean test environment by removing any persisted onchain state.
#
# Why is this needed?
# - Arcium computation definitions are onchain accounts (PDAs) that persist across validator runs
# - Computation definitions register encrypted instructions (like "vote", "create_poll", "reveal_result")
# - They are initialized ONCE per deployment, not on every test run
# - When running tests multiple times, the computation definition accounts from previous runs
#   still exist in the validator's ledger, causing "account already in use" errors when trying
#   to initialize them again
#
# Example error this fixes:
#  'Program J7KTdhMTVhy7vtgyFSXi9SpptdTDmpg93pB53UdfuttF invoke [1]'
#  'Program log: Instruction: CreatePollCompDef'
#  'Program BKck65TgoKRokMjQM3datB9oRwJ8rAj2jxPXvHXUvcL6 invoke [2]'
#  'Program log: Instruction: InitComputationDefinition'
#  'Program 11111111111111111111111111111111 invoke [3]'
#  'Allocate: account Address { address: FLpEeHKkzCKwVvC7LMV3GBSLAsmhWSvEx2z4PYKWZk6U, base: None } already in use'

# Arcium version is set by directly installing the 0.6.2 binary (in GitHub Actions)
# or by the user having arcium 0.6.2 in their PATH (local development)

# TODO: Upgrade to Agave 3.x when resolved
# Currently using Agave 2.3.11 due to Agave 3.x panic with bind-address 0.0.0.0
# See: https://solana.stackexchange.com/questions/23807/anchor-localnet-wont-start-local-validator-panicked-at-unspecifiedipaddr
# Agave 3.x throws: UnspecifiedIpAddr(0.0.0.0) panic when Arcium tries to bind validator to 0.0.0.0

# Set correct Anchor version (only if avm is available)
if command -v avm &> /dev/null; then
  avm use 0.32.1
fi

# Unset RUSTUP_TOOLCHAIN to use the Rust version from rust-toolchain.toml (1.92.0)
# This environment variable overrides rust-toolchain.toml, so we must unset it
# to ensure we use stable Rust 1.92.0 which has select_unpredictable stabilized
unset RUSTUP_TOOLCHAIN

# TODO: Remove --platform linux/amd64 workaround when Arcium publishes ARM64 Docker images
# BUG: Arcium 0.6.2 Docker images (arx-node:latest, trusted-dealer:latest) only support amd64
# This causes "no matching manifest for linux/arm64/v8" errors on Apple Silicon Macs
# Workaround: Pre-pull images with --platform flag to force Rosetta 2 emulation
# The images need to be pulled before arcium test starts docker compose
if [[ $(uname -m) == "arm64" ]]; then
  echo "Detected Apple Silicon (ARM64), pulling amd64 Docker images via Rosetta 2..."
  docker pull --platform linux/amd64 arcium/trusted-dealer:latest > /dev/null 2>&1
  docker pull --platform linux/amd64 arcium/arx-node:latest > /dev/null 2>&1
fi

# Kill any running validator process and wait for it to terminate
if pgrep -f "solana-test-validator" > /dev/null; then
  # Send TERM signal and wait for process to terminate
  # On macOS, killall -w waits for the process to terminate. 
  # On Linux (psmisc), -w doesn't exist - sorry to both Linux users.
  killall -TERM -w solana-test-validator 2>/dev/null || true
fi

# Remove the test ledger directory to clear all persisted onchain accounts
# This includes computation definitions, polls, and any other accounts from previous test runs
rm -rf .anchor/test-ledger

# Remove any existing Docker containers to clear cached MXE state
# The ARX nodes cache MXE private shares and public inputs inside the container
# If not removed, they'll show "MXE keygen computation but private shares already exist" warnings
# and may hang during initialization
docker rm -f artifacts-arx-node-0-1 artifacts-arx-node-1-1 artifacts-arcium-trusted-dealer-1 2>/dev/null || true

# Generate Codama client before running tests
# Build the program first to generate target/idl/*.json
# The Codama client generator needs this IDL to exist
arcium build

# Generate Codama client from the IDL
# This must happen after build (so IDL exists) but before test (so test can import from dist/election-client)
npx tsx create-codama-client.ts

# Run tests
# Note: arcium test will rebuild (yes, twice) but it also sets up all artifacts and localnet properly
# The double build is necessary because we need the IDL for Codama generation before testing
arcium test