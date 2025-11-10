# Standalone Arcium Election Example

![Tests](https://github.com/quiknode-labs/arcium-election/workflows/Tests/badge.svg)

Based on the https://github.com/arcium-hq/examples voting' app with a significant number of fixes (see [git history](https://github.com/quiknode-labs/arcium-election/commits/main/)), including fixes to race conditions, changing from one user voting on multiple polls to 3 users voting on a single poll, consisistent naming (between the comp def, handler, encrypted instruction handler and callback), and a simpler Anchor layout.

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


[![Watch video](https://img.youtube.com/vi/f4QDICrVjpg/maxresdefault.jpg)](https://www.youtube.com/watch?v=f4QDICrVjpg)