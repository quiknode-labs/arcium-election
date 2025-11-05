use arcium_anchor::prelude::*;

// Computation definition offsets for each encrypted instruction
pub const COMP_DEF_OFFSET_CREATE_POLL: u32 = comp_def_offset("create_poll");
pub const COMP_DEF_OFFSET_VOTE: u32 = comp_def_offset("vote");
pub const COMP_DEF_OFFSET_REVEAL: u32 = comp_def_offset("reveal_result");
