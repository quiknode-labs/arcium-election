#!/usr/bin/env bash
# Fixed 'account already in use' errors by killing the validator and removing the test ledger

#  'Program J7KTdhMTVhy7vtgyFSXi9SpptdTDmpg93pB53UdfuttF invoke [1]'
#  'Program log: Instruction: InitVoteStatsCompDef'
#  'Program BKck65TgoKRokMjQM3datB9oRwJ8rAj2jxPXvHXUvcL6 invoke [2]'
#  'Program log: Instruction: InitComputationDefinition'
#  'Program 11111111111111111111111111111111 invoke [3]'
#  'Allocate: account Address { address: FLpEeHKkzCKwVvC7LMV3GBSLAsmhWSvEx2z4PYKWZk6U, base: None } already in use'
pkill -KILL solana-test-validator 
rm -rf .anchor/test-ledger
sleep 2
arcium test