use anchor_lang::prelude::*;
use arcium_anchor::prelude::*;
use arcium_client::idl::arcium::types::CallbackAccount;

use crate::{
    error::ErrorCode, CreatePoll, CreatePollCallback, CreatePollCompDef, CreatePollOutput,
};

/// One-off job to create computation definition for `create_poll` in encrypted-ixs/src/lib.rs.
///
/// This initializes the onchain computation definition account that registers the encrypted
/// instruction. Must be called once before using the `create_poll` encrypted instruction.
pub fn init_create_poll_comp_def(ctx: Context<CreatePollCompDef>) -> Result<()> {
    init_comp_def(ctx.accounts, 0, None, None)?;
    Ok(())
}

/// Creates a new confidential poll with the given question.
///
/// This initializes a poll account and sets up the encrypted vote counters using MPC.
/// The vote tallies are stored in encrypted form and can only be revealed by the poll authority.
/// All individual votes remain completely confidential throughout the voting process.
///
/// # Arguments
/// * `id` - Unique identifier for this poll
/// * `question` - The poll question voters will respond to
/// * `nonce` - Cryptographic nonce for initializing encrypted vote counters
pub fn create_poll(
    ctx: Context<CreatePoll>,
    computation_offset: u64,
    id: u32,
    question: String,
    nonce: u128,
) -> Result<()> {
    msg!("Creating a new poll");

    // Initialize the poll account with the provided parameters
    ctx.accounts.poll_account.question = question;
    ctx.accounts.poll_account.bump = ctx.bumps.poll_account;
    ctx.accounts.poll_account.id = id;
    ctx.accounts.poll_account.authority = ctx.accounts.payer.key();
    ctx.accounts.poll_account.nonce = nonce;
    ctx.accounts.poll_account.vote_counts = [[0; 32]; 3];

    let computation_args = vec![Argument::PlaintextU128(nonce)];

    ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

    // Initialize encrypted vote counters (3 options) through MPC
    queue_computation(
        ctx.accounts,
        computation_offset,
        computation_args,
        None,
        vec![CreatePollCallback::callback_ix(&[CallbackAccount {
            pubkey: ctx.accounts.poll_account.key(),
            is_writable: true,
        }])],
        1,
    )?;

    Ok(())
}

pub fn create_poll_callback(
    ctx: Context<CreatePollCallback>,
    output: ComputationOutputs<CreatePollOutput>,
) -> Result<()> {
    let computation_result = match output {
        ComputationOutputs::Success(CreatePollOutput { field_0 }) => field_0,
        _ => return Err(ErrorCode::AbortedComputation.into()),
    };

    ctx.accounts.poll_account.vote_counts = computation_result.ciphertexts;
    ctx.accounts.poll_account.nonce = computation_result.nonce;

    Ok(())
}
