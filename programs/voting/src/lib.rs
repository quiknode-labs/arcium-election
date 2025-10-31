// Stops Rust Analyzer complaining about missing configs
// See https://solana.stackexchange.com/questions/17777
#![allow(unexpected_cfgs)]
// Fix warning: use of deprecated method `anchor_lang::prelude::AccountInfo::<'a>::realloc`: Use AccountInfo::resize() instead
// See https://solana.stackexchange.com/questions/22979
#![allow(deprecated)]

use anchor_lang::prelude::*;
use arcium_anchor::prelude::*;
use arcium_client::idl::arcium::types::CallbackAccount;

const COMP_DEF_OFFSET_INIT_VOTE_STATS: u32 = comp_def_offset("init_vote_stats");
const COMP_DEF_OFFSET_VOTE: u32 = comp_def_offset("vote");
const COMP_DEF_OFFSET_REVEAL: u32 = comp_def_offset("reveal_result");

declare_id!("J7KTdhMTVhy7vtgyFSXi9SpptdTDmpg93pB53UdfuttF");

#[arcium_program]
pub mod voting {
    use super::*;

    pub fn init_vote_stats_comp_def(ctx: Context<InitVoteStatsCompDef>) -> Result<()> {
        init_comp_def(ctx.accounts, true, 0, None, None)?;
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
    pub fn create_new_poll(
        ctx: Context<CreateNewPoll>,
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
        ctx.accounts.poll_acc.vote_state = [[0; 32]; 3];

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

    #[arcium_callback(encrypted_ix = "init_vote_stats")]
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

    pub fn init_vote_comp_def(ctx: Context<InitVoteCompDef>) -> Result<()> {
        init_comp_def(ctx.accounts, true, 0, None, None)?;
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
    /// * `vote` - Encrypted vote (0, 1, or 2 for the three options)
    /// * `vote_encryption_pubkey` - Voter's public key for encryption
    /// * `vote_nonce` - Cryptographic nonce for the vote encryption
    ///
    /// Note: The `unused_variables` warning for `poll_id` is spurious. The parameter is actually used
    /// in the `Vote` struct's `#[account]` constraint on line 391 via `poll_id.to_le_bytes()` for PDA
    /// derivation. However, Rust's compiler cannot detect this usage because Anchor's macros expand
    /// after the static analysis phase, so it appears unused in the function body.
    #[allow(unused_variables)]
    pub fn vote(
        ctx: Context<Vote>,
        computation_offset: u64,
        poll_id: u32,
        vote: [u8; 32],
        vote_encryption_pubkey: [u8; 32],
        vote_nonce: u128,
    ) -> Result<()> {
        let computation_args = vec![
            Argument::ArcisPubkey(vote_encryption_pubkey),
            Argument::PlaintextU128(vote_nonce),
            Argument::EncryptedU8(vote),
            Argument::PlaintextU128(ctx.accounts.poll_acc.nonce),
            Argument::Account(
                ctx.accounts.poll_acc.key(),
                // Offset calculation: 8 bytes (discriminator) + 1 byte (bump)
                8 + 1,
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
                pubkey: ctx.accounts.poll_acc.key(),
                is_writable: true,
            }])],
        )?;
        Ok(())
    }

    #[arcium_callback(encrypted_ix = "vote")]
    pub fn vote_callback(
        ctx: Context<VoteCallback>,
        output: ComputationOutputs<VoteOutput>,
    ) -> Result<()> {
        let vote_result = match output {
            ComputationOutputs::Success(VoteOutput { field_0 }) => field_0,
            _ => return Err(ErrorCode::AbortedComputation.into()),
        };

        ctx.accounts.poll_acc.vote_state = vote_result.ciphertexts;
        ctx.accounts.poll_acc.nonce = vote_result.nonce;

        let clock = Clock::get()?;
        let current_timestamp = clock.unix_timestamp;

        emit!(VoteEvent {
            timestamp: current_timestamp,
        });

        Ok(())
    }

    pub fn init_reveal_result_comp_def(ctx: Context<InitRevealResultCompDef>) -> Result<()> {
        init_comp_def(ctx.accounts, true, 0, None, None)?;
        Ok(())
    }

    /// Reveals the final result of the poll.
    ///
    /// Only the poll authority can call this function to decrypt and reveal the vote tallies.
    /// The MPC computation compares all three vote counts and returns the winning option.
    ///
    /// # Arguments
    /// * `id` - The poll ID to reveal results for
    pub fn reveal_result(
        ctx: Context<RevealVotingResult>,
        computation_offset: u64,
        id: u32,
    ) -> Result<()> {
        require!(
            ctx.accounts.payer.key() == ctx.accounts.poll_acc.authority,
            ErrorCode::InvalidAuthority
        );

        msg!("Revealing voting result for poll with id {}", id);

        let computation_args = vec![
            Argument::PlaintextU128(ctx.accounts.poll_acc.nonce),
            Argument::Account(
                ctx.accounts.poll_acc.key(),
                // Offset calculation: 8 bytes (discriminator) + 1 byte (bump)
                8 + 1,
                32 * 3, // 3 encrypted vote counters (Neo robot, Humane AI PIN, friend.com), 32 bytes each
            ),
        ];

        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

        queue_computation(
            ctx.accounts,
            computation_offset,
            computation_args,
            None,
            vec![RevealResultCallback::callback_ix(&[])],
        )?;
        Ok(())
    }

    #[arcium_callback(encrypted_ix = "reveal_result")]
    pub fn reveal_result_callback(
        ctx: Context<RevealResultCallback>,
        output: ComputationOutputs<RevealResultOutput>,
    ) -> Result<()> {
        let winner = match output {
            ComputationOutputs::Success(RevealResultOutput { field_0 }) => field_0,
            _ => return Err(ErrorCode::AbortedComputation.into()),
        };

        emit!(RevealResultEvent { output: winner });

        Ok(())
    }
}

#[queue_computation_accounts("init_vote_stats", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64, id: u32)]
pub struct CreateNewPoll<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init_if_needed,
        space = 9,
        payer = payer,
        seeds = [&SIGN_PDA_SEED],
        bump,
        address = derive_sign_pda!(),
    )]
    pub sign_pda_account: Account<'info, SignerAccount>,
    #[account(
        address = derive_mxe_pda!()
    )]
    pub mxe_account: Account<'info, MXEAccount>,
    #[account(
        mut,
        address = derive_mempool_pda!()
    )]
    /// CHECK: mempool_account, checked by the arcium program
    pub mempool_account: UncheckedAccount<'info>,
    #[account(
        mut,
        address = derive_execpool_pda!()
    )]
    /// CHECK: executing_pool, checked by the arcium program
    pub executing_pool: UncheckedAccount<'info>,
    #[account(
        mut,
        address = derive_comp_pda!(computation_offset)
    )]
    /// CHECK: computation_account, checked by the arcium program.
    pub computation_account: UncheckedAccount<'info>,
    #[account(
        address = derive_comp_def_pda!(COMP_DEF_OFFSET_INIT_VOTE_STATS)
    )]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(
        mut,
        address = derive_cluster_pda!(mxe_account)
    )]
    pub cluster_account: Account<'info, Cluster>,
    #[account(
        mut,
        address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS,
    )]
    pub pool_account: Account<'info, FeePool>,
    #[account(
        address = ARCIUM_CLOCK_ACCOUNT_ADDRESS,
    )]
    pub clock_account: Account<'info, ClockAccount>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
    #[account(
        init,
        payer = payer,
        space = 8 + PollAccount::INIT_SPACE,
        seeds = [b"poll", payer.key().as_ref(), id.to_le_bytes().as_ref()],
        bump,
    )]
    pub poll_acc: Account<'info, PollAccount>,
}

#[callback_accounts("init_vote_stats")]
#[derive(Accounts)]
pub struct InitVoteStatsCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,

    #[account(
        address = derive_comp_def_pda!(COMP_DEF_OFFSET_INIT_VOTE_STATS)
    )]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,

    #[account(address = ::anchor_lang::solana_program::sysvar::instructions::ID)]
    /// CHECK: instructions_sysvar, checked by the account constraint
    pub instructions_sysvar: AccountInfo<'info>,

    /// CHECK: poll_acc, checked by the callback account key passed in queue_computation
    #[account(mut)]
    pub poll_acc: Account<'info, PollAccount>,
}

#[init_computation_definition_accounts("init_vote_stats", payer)]
#[derive(Accounts)]
pub struct InitVoteStatsCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        mut,
        address = derive_mxe_pda!()
    )]
    pub mxe_account: Box<Account<'info, MXEAccount>>,

    #[account(mut)]
    /// CHECK: comp_def_account, checked by arcium program.
    /// Can't check it here as it's not initialized yet.
    pub comp_def_account: UncheckedAccount<'info>,

    pub arcium_program: Program<'info, Arcium>,

    pub system_program: Program<'info, System>,
}

#[queue_computation_accounts("vote", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64, poll_id: u32)]
pub struct Vote<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        init_if_needed,
        space = 9,
        payer = payer,
        seeds = [&SIGN_PDA_SEED],
        bump,
        address = derive_sign_pda!(),
    )]
    pub sign_pda_account: Account<'info, SignerAccount>,

    #[account(
        address = derive_mxe_pda!()
    )]
    pub mxe_account: Account<'info, MXEAccount>,

    #[account(
        mut,
        address = derive_mempool_pda!()
    )]
    /// CHECK: mempool_account, checked by the arcium program
    pub mempool_account: UncheckedAccount<'info>,

    #[account(
        mut,
        address = derive_execpool_pda!()
    )]
    /// CHECK: executing_pool, checked by the arcium program
    pub executing_pool: UncheckedAccount<'info>,

    #[account(
        mut,
        address = derive_comp_pda!(computation_offset)
    )]
    /// CHECK: computation_account, checked by the arcium program.
    pub computation_account: UncheckedAccount<'info>,

    #[account(
        address = derive_comp_def_pda!(COMP_DEF_OFFSET_VOTE)
    )]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,

    #[account(
        mut,
        address = derive_cluster_pda!(mxe_account)
    )]
    pub cluster_account: Account<'info, Cluster>,

    #[account(
        mut,
        address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS,
    )]
    pub pool_account: Account<'info, FeePool>,

    #[account(
        address = ARCIUM_CLOCK_ACCOUNT_ADDRESS,
    )]
    pub clock_account: Account<'info, ClockAccount>,

    pub system_program: Program<'info, System>,

    pub arcium_program: Program<'info, Arcium>,

    /// CHECK: Poll authority pubkey
    #[account(
        address = poll_acc.authority,
    )]
    pub authority: UncheckedAccount<'info>,

    #[account(
        seeds = [b"poll", authority.key().as_ref(), poll_id.to_le_bytes().as_ref()],
        bump = poll_acc.bump,
        has_one = authority
    )]
    pub poll_acc: Account<'info, PollAccount>,
}

#[callback_accounts("vote")]
#[derive(Accounts)]
pub struct VoteCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,

    #[account(
        address = derive_comp_def_pda!(COMP_DEF_OFFSET_VOTE)
    )]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,

    #[account(address = ::anchor_lang::solana_program::sysvar::instructions::ID)]
    /// CHECK: instructions_sysvar, checked by the account constraint
    pub instructions_sysvar: AccountInfo<'info>,

    #[account(mut)]
    pub poll_acc: Account<'info, PollAccount>,
}

#[init_computation_definition_accounts("vote", payer)]
#[derive(Accounts)]
pub struct InitVoteCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        mut,
        address = derive_mxe_pda!()
    )]
    pub mxe_account: Box<Account<'info, MXEAccount>>,

    #[account(mut)]
    /// CHECK: comp_def_account, checked by arcium program.
    /// Can't check it here as it's not initialized yet.
    pub comp_def_account: UncheckedAccount<'info>,

    pub arcium_program: Program<'info, Arcium>,

    pub system_program: Program<'info, System>,
}

#[queue_computation_accounts("reveal_result", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64, id: u32)]
pub struct RevealVotingResult<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        init_if_needed,
        space = 9,
        payer = payer,
        seeds = [&SIGN_PDA_SEED],
        bump,
        address = derive_sign_pda!(),
    )]
    pub sign_pda_account: Account<'info, SignerAccount>,

    #[account(
        address = derive_mxe_pda!()
    )]
    pub mxe_account: Account<'info, MXEAccount>,

    #[account(
        mut,
        address = derive_mempool_pda!()
    )]
    /// CHECK: mempool_account, checked by the arcium program
    pub mempool_account: UncheckedAccount<'info>,

    #[account(
        mut,
        address = derive_execpool_pda!()
    )]
    /// CHECK: executing_pool, checked by the arcium program
    pub executing_pool: UncheckedAccount<'info>,

    #[account(
        mut,
        address = derive_comp_pda!(computation_offset)
    )]
    /// CHECK: computation_account, checked by the arcium program.
    pub computation_account: UncheckedAccount<'info>,

    #[account(
        address = derive_comp_def_pda!(COMP_DEF_OFFSET_REVEAL)
    )]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,

    #[account(
        mut,
        address = derive_cluster_pda!(mxe_account)
    )]
    pub cluster_account: Account<'info, Cluster>,

    #[account(
        mut,
        address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS,
    )]
    pub pool_account: Account<'info, FeePool>,

    #[account(
        address = ARCIUM_CLOCK_ACCOUNT_ADDRESS,
    )]
    pub clock_account: Account<'info, ClockAccount>,

    pub system_program: Program<'info, System>,

    pub arcium_program: Program<'info, Arcium>,

    #[account(
        seeds = [b"poll", payer.key().as_ref(), id.to_le_bytes().as_ref()],
        bump = poll_acc.bump
    )]
    pub poll_acc: Account<'info, PollAccount>,
}

#[callback_accounts("reveal_result")]
#[derive(Accounts)]
pub struct RevealResultCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,

    #[account(
        address = derive_comp_def_pda!(COMP_DEF_OFFSET_REVEAL)
    )]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,

    #[account(address = ::anchor_lang::solana_program::sysvar::instructions::ID)]
    /// CHECK: instructions_sysvar, checked by the account constraint
    pub instructions_sysvar: AccountInfo<'info>,
}

#[init_computation_definition_accounts("reveal_result", payer)]
#[derive(Accounts)]
pub struct InitRevealResultCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        mut,
        address = derive_mxe_pda!()
    )]
    pub mxe_account: Box<Account<'info, MXEAccount>>,

    #[account(mut)]
    /// CHECK: comp_def_account, checked by arcium program.
    /// Can't check it here as it's not initialized yet.
    pub comp_def_account: UncheckedAccount<'info>,

    pub arcium_program: Program<'info, Arcium>,

    pub system_program: Program<'info, System>,
}

/// Represents a confidential poll with encrypted vote tallies.
#[account]
#[derive(InitSpace)]
pub struct PollAccount {
    /// PDA bump seed
    pub bump: u8,
    /// Encrypted vote counters: [neo_robot_count, humane_ai_pin_count, friend_com_count] as 32-byte ciphertexts
    pub vote_state: [[u8; 32]; 3],
    /// Unique identifier for this poll
    pub id: u32,
    /// Public key of the poll creator (only they can reveal results)
    pub authority: Pubkey,
    /// Cryptographic nonce for the encrypted vote counters
    pub nonce: u128,
    /// The poll question (max 50 characters)
    #[max_len(50)]
    pub question: String,
}

#[error_code]
pub enum ErrorCode {
    #[msg("Invalid authority")]
    InvalidAuthority,
    #[msg("The computation was aborted")]
    AbortedComputation,
    #[msg("Cluster not set")]
    ClusterNotSet,
}

#[event]
pub struct VoteEvent {
    pub timestamp: i64,
}

#[event]
pub struct RevealResultEvent {
    /// The winning option: 0 = Neo robot, 1 = Humane AI PIN, 2 = friend.com
    pub output: u8,
}
