# Private Elections on Solana with Arcium

![Tests](https://github.com/quiknode-labs/arcium-election/workflows/Test/badge.svg)

Based on the https://github.com/arcium-hq/examples 'voting' app with a [significant number of fixes](https://github.com/quiknode-labs/arcium-election/commits/main/).

## To Run

- Install Arcium
- Use older Anchor 
`avm use 0.31.1`
- Use custom version of Rust Arcium wants:
- `unset RUSTUP_TOOLCHAIN`

- Get Docker https://docs.docker.com/desktop/setup/install/mac-install/
- Start Docker desktop (`docker daemon not running`)

Run `bash run-tests.bash`. That will:

 - Remove the old test-ledger, so the old compdef accounts are cleared out
 - Run `arcium test` for you to build and run the tests.

## How the Election program works, and how Arcium works

This is all explained beautifully in the video (see below), but also it's nice to have things written down:

### Creating a new Poll (creating a Solana PDA with an encrypted value)

- `create_poll` (`programs/election/src/handlers/create_poll.rs`) - creates the poll PDA, initializing the poll (programs/election/src/state/poll.rs) with its regular values, but leaving `vote_counts` empty. Create poll then uses `queue_computation` to invoke...
- `create_poll` (`encrypted-ixs/src/lib.rs`) to create the initial encrypted value of `vote_counts` (i.e, `[0, 0, 0]`, encrypted), which will be received by...
- `create_poll_callback` - receives the encrypted `[0, 0, 0]` and saves them to the `vote_counts`

### Voting (sending instructions with encrypted values and manipulating encrypted data)

- Clients get a `sharedSecret` (`tests/helpers.ts`) they can use to encrypt values they sent to instruction handlers
- Client invoke the instruction handlers like normal (using Anchor JS or a Codama client - see `tests/election.ts`) specifying the encrypted value as their `choice` and specifying the address of the `poll`
- `vote` (`programs/election/src/handlers/vote.rs`) gets the `choice` and the current value of `vote_counts` from the `poll` and then uses `queue_computation` to invoke...
- `vote` (`encrypted-ixs/src/lib.rs`) which decrypts the `choice` and the current value of `vote_counts`, increments the choice in `vote_counts`, and encrypts the new `vote_counts`, which will be received by...
- `vote_callback` (`programs/election/src/handlers/vote.rs`) which saves the new `vote_counts` to the `poll`

### Revealing the final result

- Only the poll authority can call `reveal_result` (`programs/election/src/handlers/reveal_result.rs`) to decrypt and reveal the vote tallies. The handler uses `queue_computation` to invoke...
- `reveal_result` (`encrypted-ixs/src/lib.rs`) which decrypts the `vote_counts`, compares all three vote counts, and returns the winning option (0, 1, or 2), which will be received by...
- `reveal_result_callback` (`programs/election/src/handlers/reveal_result.rs`) which emits a `RevealResultEvent` with the winning option. We could instead save the winning option to a PDA, log it, or do whatever else we want. 

### Oh and by the way

Since we have 3 encrypted instruction handlers in `encrypted-ixs/src/lib.rs`, we have 3 matching Solana instruction handlers to deploy the compiled code to Solana PDAs - these are called `init_create_poll_comp_def`, `init_vote_comp_def`, and `init_reveal_result_comp_def`. These are called once when deploying our program, see the `before` hook in `tests/election.ts`.

## Watch the Video

[![Private transactions on Solana with Arcium](https://img.youtube.com/vi/X3Y6sL7A8O0/maxresdefault.jpg)](https://www.youtube.com/watch?v=X3Y6sL7A8O0)
