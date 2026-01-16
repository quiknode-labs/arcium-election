use anchor_lang::prelude::*;
use arcium_anchor::prelude::*;

use crate::{
    error::ErrorCode,
    state::{Poll, RevealResultEvent},
    election::{InitRevealResultCompDef, RevealResult, RevealResultCallback, RevealResultOutput},
};

/// One-off job to create computation definition for `reveal_result` in encrypted-ixs/src/lib.rs.
///
/// This initializes the onchain computation definition account that registers the encrypted
/// instruction. Must be called once before using the `reveal_result` encrypted instruction.
pub fn init_reveal_result_comp_def(ctx: Context<InitRevealResultCompDef>) -> Result<()> {
    init_comp_def(ctx.accounts, None, None)?;
    Ok(())
}

/// Reveals the final result of the poll.
///
/// Only the poll authority can call this function to decrypt and reveal the vote tallies.
/// The MPC computation compares all three vote counts and returns the winning option.
///
/// # Arguments
/// * `id` - The poll ID to reveal results for
pub fn reveal_result(ctx: Context<RevealResult>, computation_offset: u64, id: u32) -> Result<()> {
    // Only the poll authority can reveal the result
    require!(
        ctx.accounts.payer.key() == ctx.accounts.poll_account.authority,
        ErrorCode::InvalidAuthority
    );

    msg!("Revealing voting result for poll with id {}", id);

    let computation_args = ArgBuilder::new()
        .plaintext_u128(ctx.accounts.poll_account.nonce)
        .account(
            ctx.accounts.poll_account.key(),
            // Offset calculation: discriminator + 1 byte (bump)
            (Poll::DISCRIMINATOR.len() + 1) as u32,
            32 * 3, // 3 encrypted vote counters (Neo robot, Humane AI PIN, friend.com), 32 bytes each
        )
        .build();

    ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

    queue_computation(
        ctx.accounts,
        computation_offset,
        computation_args,
        None,
        vec![RevealResultCallback::callback_ix(
            computation_offset,
            &ctx.accounts.mxe_account,
            &[]
        )?],
        1,
        0,
    )?;
    Ok(())
}

pub fn reveal_result_callback(
    ctx: Context<RevealResultCallback>,
    output: SignedComputationOutputs<RevealResultOutput>,
) -> Result<()> {
    let RevealResultOutput { field_0: winner } = output.verify_output(
        &ctx.accounts.cluster_account,
        &ctx.accounts.computation_account
    )?;

    emit!(RevealResultEvent { output: winner });

    Ok(())
}
