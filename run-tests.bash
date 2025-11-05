#!/usr/bin/env bash
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

# Run the tests with a fresh ledger
arcium test