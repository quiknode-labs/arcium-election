// Stops Rust Analyzer complaining about missing configs
// See https://solana.stackexchange.com/questions/17777
#![allow(unexpected_cfgs)]
// Fix warning: use of deprecated method `anchor_lang::prelude::AccountInfo::<'a>::realloc`: Use AccountInfo::resize() instead
// See https://solana.stackexchange.com/questions/22979
#![allow(deprecated)]

use anchor_lang::prelude::*;
use arcium_anchor::prelude::*;

pub mod constants;
pub mod error;
pub mod handlers;
pub mod state;

use constants::*;
pub use error::ErrorCode;
use state::*;

declare_id!("J7KTdhMTVhy7vtgyFSXi9SpptdTDmpg93pB53UdfuttF");

#[arcium_program]
pub mod voting {
    use super::*;

    pub fn init_vote_stats_comp_def(ctx: Context<InitVoteStatsCompDef>) -> Result<()> {
        handlers::init_vote_stats::init_vote_stats_comp_def(ctx)
    }

    pub fn create_poll(
        ctx: Context<CreatePoll>,
        computation_offset: u64,
        id: u32,
        question: String,
        nonce: u128,
    ) -> Result<()> {
        handlers::create_poll::create_poll(ctx, computation_offset, id, question, nonce)
    }

    #[arcium_callback(encrypted_ix = "init_vote_stats")]
    pub fn init_vote_stats_callback(
        ctx: Context<InitVoteStatsCallback>,
        output: ComputationOutputs<InitVoteStatsOutput>,
    ) -> Result<()> {
        handlers::init_vote_stats::init_vote_stats_callback(ctx, output)
    }

    pub fn init_vote_comp_def(ctx: Context<InitVoteCompDef>) -> Result<()> {
        handlers::vote::init_vote_comp_def(ctx)
    }

    #[allow(unused_variables)]
    pub fn vote(
        ctx: Context<Vote>,
        computation_offset: u64,
        poll_id: u32,
        vote: [u8; 32],
        vote_encryption_pubkey: [u8; 32],
        vote_nonce: u128,
    ) -> Result<()> {
        handlers::vote::vote(ctx, computation_offset, poll_id, vote, vote_encryption_pubkey, vote_nonce)
    }

    #[arcium_callback(encrypted_ix = "vote")]
    pub fn vote_callback(
        ctx: Context<VoteCallback>,
        output: ComputationOutputs<VoteOutput>,
    ) -> Result<()> {
        handlers::vote::vote_callback(ctx, output)
    }

    pub fn init_reveal_result_comp_def(ctx: Context<InitRevealResultCompDef>) -> Result<()> {
        handlers::reveal_result::init_reveal_result_comp_def(ctx)
    }

    pub fn reveal_result(
        ctx: Context<RevealVotingResult>,
        computation_offset: u64,
        id: u32,
    ) -> Result<()> {
        handlers::reveal_result::reveal_result(ctx, computation_offset, id)
    }

    #[arcium_callback(encrypted_ix = "reveal_result")]
    pub fn reveal_result_callback(
        ctx: Context<RevealResultCallback>,
        output: ComputationOutputs<RevealResultOutput>,
    ) -> Result<()> {
        handlers::reveal_result::reveal_result_callback(ctx, output)
    }

    // Account struct definitions - these need to be inside the arcium_program module
    // so they can access the generated SignerAccount type

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

    #[queue_computation_accounts("init_vote_stats", payer)]
    #[derive(Accounts)]
    #[instruction(computation_offset: u64, id: u32)]
    pub struct CreatePoll<'info> {
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
}

pub use voting::{
    CreatePoll,
    InitRevealResultCompDef,
    InitVoteCompDef,
    InitVoteStatsCallback,
    InitVoteStatsCompDef,
    InitVoteStatsOutput,
    RevealResultCallback,
    RevealResultOutput,
    RevealVotingResult,
    Vote,
    VoteCallback,
    VoteOutput,
};
