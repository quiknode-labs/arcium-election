use anchor_lang::prelude::*;
use arcium_anchor::prelude::*;

use crate::{error::ErrorCode, InitVoteStatsCallback, InitVoteStatsCompDef, InitVoteStatsOutput};

pub fn init_vote_stats_comp_def(ctx: Context<InitVoteStatsCompDef>) -> Result<()> {
    init_comp_def(ctx.accounts, true, 0, None, None)?;
    Ok(())
}

pub fn init_vote_stats_callback(
    ctx: Context<InitVoteStatsCallback>,
    output: ComputationOutputs<InitVoteStatsOutput>,
) -> Result<()> {
    let computation_result = match output {
        ComputationOutputs::Success(InitVoteStatsOutput { field_0 }) => field_0,
        _ => return Err(ErrorCode::AbortedComputation.into()),
    };

    ctx.accounts.poll_acc.vote_state = computation_result.ciphertexts;
    ctx.accounts.poll_acc.nonce = computation_result.nonce;

    Ok(())
}
