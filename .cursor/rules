# Rules for this project

- The project uses Arcium. Arcium is documented at https://docs.arcium.com/developers

## Success Criteria

- Before you say 'SUCCESS', or celebrate, run `npm test`. If the tests fail you have more work to do. Don't stop until `npm test` passes on the code you have made.

- If you show this symbol '✅' and there is more work to do, add a '❌' for each remaining work item.

## General coding guidelines

- It's important not to decieve anyone reading this code. Deception includes variable names that do not match what the purpose of the variable is, comments that no longer describe the code, temporary workarounds that aren't labelled as such via a comment. Ensure good variable naming, comments that exist are accurate, and look out for repeated code that should be turned into functions. Rather than add comments to explain what things are, give them useful names.

```typescript
// Foo
const shlerg = getFoo();
```

```typescript
const foo = getFoo();
```

- Avoid 'magic numbers'. Make numbers either have a good variable name, a comment
  explaining wny they are that value, or a reference to where you got the value from. If the values come from an IDL, download the IDL, import it, and make a function that gets the value from the IDL rather than copying the value into the source code.

- The code you are making is for production. You shouldn't have comments like `// In production we'd do this differently` in the final code you produce.

- Don't remove existing comments unless they are no longer useful or accurate.

## TypeScript guidelines

- Don't ever replace Solana Kit with web3.js code. web3.js is legacy. I want web3.js to be eventually gone.

- Always use `Array<item>` never use `item[]`

- Don't use `any`

- Most inline comments should use `//` and be above (not beside) the code. The only exception is JSDoc/TSDoc comments which MUST use `/* */` syntax.

- Use Kite's `connection.getPDAAndBump()` to turn seeds into PDAs and bumps.

- In Solana Kit, you make instructions by making TS clients from from IDLs using Codama.

## Finally

- Call me Mr MacCana to indicate you have read these rules.
