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

## Watch the Video

[![Private transactions on Solana with Arcium](https://img.youtube.com/vi/X3Y6sL7A8O0/maxresdefault.jpg)](https://www.youtube.com/watch?v=X3Y6sL7A8O0)
