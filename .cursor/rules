# Rules for this project

- The project uses Arcium. Arcium is documented at https://docs.arcium.com/developers 

- Before you say 'SUCCESS', or celebrate, run `run-tests.bash`. If the tests fail you have more work to do. 

- If you show this symbol '✅' and there is more work to do, add a '❌' for each remaining work item. 

- Don't ever replace web3.js code with Solana Kit code. web3.js is legacy. I want it to be eventually gone.

- Always use `Array<item>` never use `item[]`

- Don't use `any`

- Avoid 'magic numbers'. Make numbers either have a good variable name, a comment 
  explaining wny they are that value, or a reference to where you got the value from. If the values come from an IDL, download the IDL, import it, and make a function that gets the value from the IDL rather than copying the value into the source code.

- Use connection.getPDAAndBump to turn seeds into PDAs and bumps.

- The code you are making is for production. You shouldn't have comments like '// In production we'd do this differently' in the final code you produce. 

- Don't stop until `run-tests.bash` passes on the code you have made.

- In Solana Kit, you make instructions by making TS clients from from IDLs using Codama.\

export const keypairToSigner = async (legacyWallet: any) => {
  const keypair = await fromLegacyKeypair(legacyWallet);
  const signer: KeyPairSigner = await createSignerFromKeyPair(keypair);
  return signer;
};