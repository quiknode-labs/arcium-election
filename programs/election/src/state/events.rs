use anchor_lang::prelude::*;

#[event]
pub struct VoteEvent {
    pub timestamp: i64,
}

#[event]
pub struct RevealResultEvent {
    /// The winning option: 0 = Neo robot, 1 = Humane AI PIN, 2 = friend.com
    pub output: u8,
}
