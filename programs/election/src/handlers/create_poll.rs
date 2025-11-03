use anchor_lang::prelude::*;
use arcium_anchor::prelude::*;
use arcium_client::idl::arcium::types::CallbackAccount;

use crate::{CreatePoll, InitVoteStatsCallback};

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
    ctx.accounts.poll_acc.question = question;
    ctx.accounts.poll_acc.bump = ctx.bumps.poll_acc;
    ctx.accounts.poll_acc.id = id;
    ctx.accounts.poll_acc.authority = ctx.accounts.payer.key();
    ctx.accounts.poll_acc.nonce = nonce;
    ctx.accounts.poll_acc.vote_counts = [[0; 32]; 3];

    let computation_args = vec![Argument::PlaintextU128(nonce)];

    ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

    // Initialize encrypted vote counters (3 options) through MPC
    queue_computation(
        ctx.accounts,
        computation_offset,
        computation_args,
        None,
        vec![InitVoteStatsCallback::callback_ix(&[CallbackAccount {
            pubkey: ctx.accounts.poll_acc.key(),
            is_writable: true,
        }])],
    )?;

    Ok(())
}
