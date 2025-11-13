use anchor_lang::prelude::*;
use arcium_anchor::prelude::*;
use arcium_client::idl::arcium::types::CallbackAccount;

use crate::{
    error::ErrorCode,
    state::{Poll, VoteEvent},
    InitVoteCompDef, Vote, VoteCallback, VoteOutput,
};

/// One-off job to create computation definition for `vote` in encrypted-ixs/src/lib.rs.
///
/// This initializes the onchain computation definition account that registers the encrypted
/// instruction. Must be called once before using the `vote` encrypted instruction.
pub fn init_vote_comp_def(ctx: Context<InitVoteCompDef>) -> Result<()> {
    init_comp_def(ctx.accounts, 0, None, None)?;
    Ok(())
}

/// Submits an encrypted vote to the poll.
///
/// This function allows a voter to cast their vote (0 = Neo robot, 1 = Humane AI PIN, 2 = friend.com) in encrypted form.
/// The vote is added to the running tally through MPC computation, ensuring
/// that individual votes remain confidential while updating the overall count.
///
/// # Arguments
/// * `poll_id` - The poll ID (used for account derivation via Anchor's #[instruction] attribute)
/// * `choice` - Encrypted vote choice (0, 1, or 2 for the three options)
/// * `vote_encryption_pubkey` - Voter's public key for encryption
/// * `vote_nonce` - Cryptographic nonce for the vote encryption
///
/// Note: The `unused_variables` warning for `poll_id` is spurious. The parameter is actually used
/// in the `Vote` struct's `#[account]` constraint via `poll_id.to_le_bytes()` for PDA
/// derivation. However, Rust's compiler cannot detect this usage because Anchor's macros expand
/// after the static analysis phase, so it appears unused in the function body.
#[allow(unused_variables)]
pub fn vote(
    ctx: Context<Vote>,
    computation_offset: u64,
    poll_id: u32,
    choice: [u8; 32],
    vote_encryption_pubkey: [u8; 32],
    vote_nonce: u128,
) -> Result<()> {
    let computation_args = vec![
        Argument::ArcisPubkey(vote_encryption_pubkey),
        Argument::PlaintextU128(vote_nonce),
        Argument::EncryptedU8(choice),
        Argument::PlaintextU128(ctx.accounts.poll_account.nonce),
        Argument::Account(
            ctx.accounts.poll_account.key(),
            // Offset calculation: discriminator + 1 byte (bump)
            (Poll::DISCRIMINATOR.len() + 1) as u32,
            32 * 3, // 3 vote counters (Neo robot, Humane AI PIN, friend.com), each stored as 32-byte ciphertext
        ),
    ];

    ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

    queue_computation(
        ctx.accounts,
        computation_offset,
        computation_args,
        None,
        vec![VoteCallback::callback_ix(&[CallbackAccount {
            pubkey: ctx.accounts.poll_account.key(),
            is_writable: true,
        }])],
        1,
    )?;
    Ok(())
}

pub fn vote_callback(
    ctx: Context<VoteCallback>,
    output: ComputationOutputs<VoteOutput>,
) -> Result<()> {
    let vote_result = match output {
        ComputationOutputs::Success(VoteOutput { field_0 }) => field_0,
        _ => return Err(ErrorCode::AbortedComputation.into()),
    };

    ctx.accounts.poll_account.vote_counts = vote_result.ciphertexts;
    ctx.accounts.poll_account.nonce = vote_result.nonce;

    let clock = Clock::get()?;
    let current_timestamp = clock.unix_timestamp;

    emit!(VoteEvent {
        timestamp: current_timestamp,
    });

    Ok(())
}
