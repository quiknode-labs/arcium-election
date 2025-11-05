use arcis_imports::*;

#[encrypted]
mod circuits {
    use arcis_imports::*;

    /// Tracks the encrypted vote tallies for a poll.
    /// Three voting options: 0 = Neo robot, 1 = Humane AI PIN, 2 = friend.com
    pub type VoteCounts = [u64; 3];

    /// Represents a single encrypted vote.
    /// 0 = Neo robot, 1 = Humane AI PIN, 2 = friend.com
    pub struct UserVote {
        vote: u8,
    }

    /// Initializes encrypted vote counters for a new poll.
    ///
    /// Creates a VoteCounts structure with zero counts for all three voting options.
    /// The counters remain encrypted and can only be updated through MPC operations.
    #[instruction]
    pub fn init_poll(mxe: Mxe) -> Enc<Mxe, VoteCounts> {
        let vote_counts: VoteCounts = [0, 0, 0];
        mxe.from_arcis(vote_counts)
    }

    /// Processes an encrypted vote and updates the running tallies.
    ///
    /// Takes an individual vote and adds it to the appropriate counter
    /// without revealing the vote value. The updated vote statistics remain encrypted
    /// and can only be revealed by the poll authority.
    ///
    /// # Arguments
    /// * `vote_ctx` - The encrypted vote to be counted (0, 1, or 2)
    /// * `vote_counts_ctx` - Current encrypted vote tallies
    ///
    /// # Returns
    /// Updated encrypted vote statistics with the new vote included
    #[instruction]
    pub fn vote(
        vote_ctx: Enc<Shared, UserVote>,
        vote_counts_ctx: Enc<Mxe, VoteCounts>,
    ) -> Enc<Mxe, VoteCounts> {
        let user_vote = vote_ctx.to_arcis();
        let mut vote_counts = vote_counts_ctx.to_arcis();

        // Increment appropriate counter based on vote value
        // Note: Must use explicit conditionals to avoid information leakage in encrypted circuits
        if user_vote.vote == 0 {
            vote_counts[0] += 1;
        } else if user_vote.vote == 1 {
            vote_counts[1] += 1;
        } else {
            vote_counts[2] += 1;
        }

        vote_counts_ctx.owner.from_arcis(vote_counts)
    }

    /// Reveals the final result of the poll by comparing vote tallies.
    ///
    /// Decrypts the vote counters and determines which option received the most votes.
    /// Only the final result (winner) is revealed, not the actual vote counts.
    ///
    /// # Arguments
    /// * `vote_counts_ctx` - Encrypted vote tallies to be revealed
    ///
    /// # Returns
    /// The winning option: 0 = Neo robot, 1 = Humane AI PIN, 2 = friend.com
    /// In case of a tie, returns the option with the lower index that tied.
    #[instruction]
    pub fn reveal_result(vote_counts_ctx: Enc<Mxe, VoteCounts>) -> u8 {
        let vote_counts = vote_counts_ctx.to_arcis();

        // Reveal all vote counts first (must be unconditional)
        let count0 = vote_counts[0].reveal();
        let count1 = vote_counts[1].reveal();
        let count2 = vote_counts[2].reveal();

        // Find the maximum count using chained .max() calls.
        // Note: Arcis only supports `use arcis_imports::*`, so std imports like
        // `use std::cmp;` are not available. Chaining .max() is the idiomatic
        // Rust approach for finding the max of 3+ values when std::cmp::max
        // or iterator methods are unavailable.
        let max_count = count0.max(count1).max(count2);

        // Return the index of the maximum (first match in case of ties)
        // Note: Can't use early returns in Arcis, so we use if-else-if chain as an expression
        if count0 == max_count {
            0u8
        } else if count1 == max_count {
            1u8
        } else {
            2u8
        }
    }
}
