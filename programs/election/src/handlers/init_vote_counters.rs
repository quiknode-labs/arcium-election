use anchor_lang::prelude::*;
use arcium_anchor::prelude::*;

use crate::{error::ErrorCode, InitVoteCountersCallback, InitVoteCountersCompDef, InitVoteCountersOutput};

pub fn init_vote_counters_comp_def(ctx: Context<InitVoteCountersCompDef>) -> Result<()> {
    init_comp_def(ctx.accounts, true, 0, None, None)?;
    Ok(())
}

pub fn init_vote_counters_callback(
    ctx: Context<InitVoteCountersCallback>,
    output: ComputationOutputs<InitVoteCountersOutput>,
) -> Result<()> {
    let computation_result = match output {
        ComputationOutputs::Success(InitVoteCountersOutput { field_0 }) => field_0,
        _ => return Err(ErrorCode::AbortedComputation.into()),
    };

    ctx.accounts.poll_acc.vote_counts = computation_result.ciphertexts;
    ctx.accounts.poll_acc.nonce = computation_result.nonce;

    Ok(())
}

