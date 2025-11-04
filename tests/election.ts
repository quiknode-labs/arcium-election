import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Keypair, PublicKey } from "@solana/web3.js";
import { Election } from "../target/types/election";
import { randomBytes } from "crypto";
import {
  awaitComputationFinalization,
  getArciumEnv,
  getCompDefAccOffset,
  getArciumAccountBaseSeed,
  getArciumProgAddress,
  uploadCircuit,
  buildFinalizeCompDefTx,
  RescueCipher,
  deserializeLE,
  getMXEAccAddress,
  getMempoolAccAddress,
  getCompDefAccAddress,
  getExecutingPoolAccAddress,
  getComputationAccAddress,
} from "@arcium-hq/client";
import * as fs from "fs/promises";
import * as os from "os";
import { getKeypairFromFile, airdropIfRequired } from "@solana-developers/helpers"
import { describe, test, before } from "node:test";
import assert from "node:assert";
import { getRandomBigNumber, makeClientSideKeys, awaitEvent } from "./helpers";

describe("Election", () => {
  // Configure the client to use the local cluster.
  anchor.setProvider(anchor.AnchorProvider.env());
  const program = anchor.workspace.Election as Program<Election>;
  const provider = anchor.getProvider();

  const arciumEnv = getArciumEnv();

  // The Poll ID we're going to create
  const pollId = 420;

  // Vote options enum: 0 = Neo robot, 1 = Humane AI PIN, 2 = friend.com
  enum VoteOption {
    NeoRobot = 0,
    HumaneAIPIN = 1,
    FriendCom = 2,
  }

  const OPTION_NAMES: Array<string> = ["Neo robot", "Humane AI PIN", "friend.com"];

  const getOptionName = (index: number): string => OPTION_NAMES[index] ?? `Option ${index}`;

  // Poll authority keypair for creating polls and initializing computation definitions
  let pollAuthority: anchor.web3.Keypair;

  before(async () => {
    pollAuthority = await getKeypairFromFile(`${os.homedir()}/.config/solana/id.json`);

    // Computation definitions are persistent onchain PDAs that register encrypted instructions
    // (like "vote", "init_vote_counters", "reveal_result"). They must be initialized ONCE per
    // deployment/test session. Re-initializing them in the same session would cause "account
    // already in use" errors since the accounts already exist onchain. This setup is separate
    // from test logic and only needs to happen once before running any tests.
    await initVoteCountersCompDef(program, pollAuthority, false, false);
    await initVoteCompDef(program, pollAuthority, false, false);
    await initRevealResultCompDef(program, pollAuthority, false, false);

    // Create the poll (owner creates it) before tests run.
    // The poll is an onchain account that persists, so it's created once and reused across tests.
    const pollNonce = randomBytes(16);

    const pollComputationOffset = getRandomBigNumber();

    const createPollSignature = await program.methods
      .createPoll(
        pollComputationOffset,
        pollId,
        `Worst tech invention of 2025?`,
        new anchor.BN(deserializeLE(pollNonce).toString())
      )
      .accountsPartial({
        computationAccount: getComputationAccAddress(
          program.programId,
          pollComputationOffset
        ),
        clusterAccount: arciumEnv.arciumClusterPubkey,
        mxeAccount: getMXEAccAddress(program.programId),
        mempoolAccount: getMempoolAccAddress(program.programId),
        executingPool: getExecutingPoolAccAddress(program.programId),
        compDefAccount: getCompDefAccAddress(
          program.programId,
          Buffer.from(getCompDefAccOffset("init_vote_counters")).readUInt32LE()
        ),
      })
      .rpc({ skipPreflight: true, commitment: "confirmed" });

    console.log(`🆕 Poll ${pollId} created with signature`, createPollSignature);

    const finalizePollSignature = await awaitComputationFinalization(
      provider as anchor.AnchorProvider,
      pollComputationOffset,
      program.programId,
      "confirmed"
    );
    console.log(`Finalize poll ${pollId} signature is `, finalizePollSignature);
    console.log("✅ Poll created");
  });

  test("users can vote on polls!", async () => {
    // Create separate users: alice, bob, and carol
    const alice = Keypair.generate();
    const bob = Keypair.generate();
    const carol = Keypair.generate();

    // Define votes for each user
    // Alice votes NeoRobot, Bob votes NeoRobot, Carol votes HumaneAIPIN
    // Expected: NeoRobot wins (2 votes)
    const aliceChoice = VoteOption.NeoRobot;
    const bobChoice = VoteOption.NeoRobot;
    const carolChoice = VoteOption.HumaneAIPIN;

    // Calculate expected outcome based on majority vote from alice, bob, and carol
    const calculateExpectedOutcome = (
      aliceChoice: number,
      bobChoice: number,
      carolChoice: number
    ): number => {
      const counts: Array<number> = [0, 0, 0];
      [aliceChoice, bobChoice, carolChoice].forEach(vote => counts[vote]++);
      return counts.indexOf(Math.max(...counts));
    };

    const expectedOutcome = calculateExpectedOutcome(aliceChoice, bobChoice, carolChoice);

    // Fund voters with SOL for transaction fees (1 SOL each)
    await airdropIfRequired(
      provider.connection,
      alice.publicKey,
      1_000_000_000, // 1 SOL in lamports
      500_000_000 // 0.5 SOL minimum balance threshold
    );
    await airdropIfRequired(
      provider.connection,
      bob.publicKey,
      1_000_000_000,
      500_000_000
    );
    await airdropIfRequired(
      provider.connection,
      carol.publicKey,
      1_000_000_000,
      500_000_000
    );

    // Create encryption keys for each user
    const aliceKeys = await makeClientSideKeys(provider as anchor.AnchorProvider, program.programId);
    // console.log("MXE x25519 pubkey for alice is", aliceKeys.publicKey);
    const bobKeys = await makeClientSideKeys(provider as anchor.AnchorProvider, program.programId);
    // console.log("MXE x25519 pubkey for bob is", bobKeys.publicKey);
    const carolKeys = await makeClientSideKeys(provider as anchor.AnchorProvider, program.programId);
    // console.log("MXE x25519 pubkey for carol is", carolKeys.publicKey);

    // Create encryption ciphers for each user
    const aliceCipher = new RescueCipher(aliceKeys.sharedSecret);
    const bobCipher = new RescueCipher(bobKeys.sharedSecret);
    const carolCipher = new RescueCipher(carolKeys.sharedSecret);

    // Helper function to cast a vote
    const castVote = async (
      voter: Keypair,
      voterName: string,
      pollId: number,
      choice: number,
      cipher: RescueCipher,
      encryptionPublicKey: Uint8Array
    ) => {
      const plaintext = [BigInt(choice)];
      const nonce = randomBytes(16);
      const ciphertext = cipher.encrypt(plaintext, nonce);

      console.log(`${voterName} voting for poll ${pollId}: ${getOptionName(choice)}`);

      const voteComputationOffset = getRandomBigNumber();
      const voteEventPromise = awaitEvent(program, "voteEvent");

      const queueVoteSignature = await program.methods
        .vote(
          voteComputationOffset,
          pollId,
          Array.from(ciphertext[0]),
          Array.from(encryptionPublicKey),
          new anchor.BN(deserializeLE(nonce).toString())
        )
        .accountsPartial({
          payer: voter.publicKey,
          computationAccount: getComputationAccAddress(
            program.programId,
            voteComputationOffset
          ),
          clusterAccount: arciumEnv.arciumClusterPubkey,
          mxeAccount: getMXEAccAddress(program.programId),
          mempoolAccount: getMempoolAccAddress(program.programId),
          executingPool: getExecutingPoolAccAddress(program.programId),
          compDefAccount: getCompDefAccAddress(
            program.programId,
            Buffer.from(getCompDefAccOffset("vote")).readUInt32LE()
          ),
          authority: pollAuthority.publicKey,
        })
        .signers([voter])
        .rpc({ skipPreflight: true, commitment: "confirmed" });
      console.log(`${voterName} queue vote for poll ${pollId} signature is `, queueVoteSignature);

      const finalizeVoteSignature = await awaitComputationFinalization(
        provider as anchor.AnchorProvider,
        voteComputationOffset,
        program.programId,
        "confirmed"
      );
      console.log(`${voterName} finalize vote for poll ${pollId} signature is `, finalizeVoteSignature);

      const voteEvent = await voteEventPromise;
      console.log(
        `🗳️ ${voterName} voted ${getOptionName(choice)} (${choice}) for poll ${pollId} at timestamp `,
        voteEvent.timestamp.toString()
      );
    };

    // Alice votes first
    await castVote(alice, "Alice", pollId, aliceChoice, aliceCipher, aliceKeys.publicKey);

    // Bob votes second
    await castVote(bob, "Bob", pollId, bobChoice, bobCipher, bobKeys.publicKey);

    // Carol votes third
    await castVote(carol, "Carol", pollId, carolChoice, carolCipher, carolKeys.publicKey);

    // Reveal results and verify against expected outcome
    const revealEventPromise = awaitEvent(program, "revealResultEvent");

    const revealComputationOffset = getRandomBigNumber();

    const revealQueueSignature = await program.methods
      .revealResult(revealComputationOffset, pollId)
      .accountsPartial({
        computationAccount: getComputationAccAddress(
          program.programId,
          revealComputationOffset
        ),
        clusterAccount: arciumEnv.arciumClusterPubkey,
        mxeAccount: getMXEAccAddress(program.programId),
        mempoolAccount: getMempoolAccAddress(program.programId),
        executingPool: getExecutingPoolAccAddress(program.programId),
        compDefAccount: getCompDefAccAddress(
          program.programId,
          Buffer.from(getCompDefAccOffset("reveal_result")).readUInt32LE()
        ),
      })
      .rpc({ skipPreflight: true, commitment: "confirmed" });
    // console.log(`Reveal queue for poll ${pollId} signature is `, revealQueueSignature);

    const revealFinalizeSignature = await awaitComputationFinalization(
      provider as anchor.AnchorProvider,
      revealComputationOffset,
      program.programId,
      "confirmed"
    );
    // console.log(
    //   `Reveal finalize for poll ${pollId} signature is `,
    //   revealFinalizeSignature
    // );

    const revealEvent = await revealEventPromise;
    console.log(
      `🏆 Decrypted winner for poll ${pollId} is "${getOptionName(revealEvent.output)}"`
    );
    assert.equal(revealEvent.output, expectedOutcome);
  });

  const initVoteCountersCompDef = async (
    program: Program<Election>,
    pollAuthority: anchor.web3.Keypair,
    uploadRawCircuit: boolean,
    offchainSource: boolean
  ): Promise<string> => {
    const baseSeedCompDefAcc = getArciumAccountBaseSeed(
      "ComputationDefinitionAccount"
    );
    const offset = getCompDefAccOffset("init_vote_counters");

    const compDefPDA = PublicKey.findProgramAddressSync(
      [baseSeedCompDefAcc, program.programId.toBuffer(), offset],
      getArciumProgAddress()
    )[0];

    console.log(
      "Init vote counters computation definition pda is ",
      compDefPDA.toBase58()
    );

    const transactionSignature = await program.methods
      .initVoteCountersCompDef()
      .accounts({
        compDefAccount: compDefPDA,
        payer: pollAuthority.publicKey,
        mxeAccount: getMXEAccAddress(program.programId),
      })
      .signers([pollAuthority])
      .rpc({
        commitment: "confirmed",
        preflightCommitment: "confirmed",
      });
    console.log("Init vote counters computation definition transaction", transactionSignature);

    if (uploadRawCircuit) {
      const rawCircuit = await fs.readFile("build/init_vote_counters.arcis");

      await uploadCircuit(
        provider as anchor.AnchorProvider,
        "init_vote_counters",
        program.programId,
        rawCircuit,
        true
      );
    } else if (!offchainSource) {
      const finalizeTx = await buildFinalizeCompDefTx(
        provider as anchor.AnchorProvider,
        Buffer.from(offset).readUInt32LE(),
        program.programId
      );

      const latestBlockhash = await provider.connection.getLatestBlockhash();
      finalizeTx.recentBlockhash = latestBlockhash.blockhash;
      finalizeTx.lastValidBlockHeight = latestBlockhash.lastValidBlockHeight;

      finalizeTx.sign(pollAuthority);

      await provider.sendAndConfirm(finalizeTx);
    }
    return transactionSignature;
  }

  const initVoteCompDef = async (
    program: Program<Election>,
    pollAuthority: anchor.web3.Keypair,
    uploadRawCircuit: boolean,
    offchainSource: boolean
  ): Promise<string> => {
    const baseSeedCompDefAcc = getArciumAccountBaseSeed(
      "ComputationDefinitionAccount"
    );
    const offset = getCompDefAccOffset("vote");

    const compDefPDA = PublicKey.findProgramAddressSync(
      [baseSeedCompDefAcc, program.programId.toBuffer(), offset],
      getArciumProgAddress()
    )[0];

    console.log("Vote computation definition pda is ", compDefPDA.toBase58());

    const transactionSignature = await program.methods
      .initVoteCompDef()
      .accounts({
        compDefAccount: compDefPDA,
        payer: pollAuthority.publicKey,
        mxeAccount: getMXEAccAddress(program.programId),
      })
      .signers([pollAuthority])
      .rpc({
        commitment: "confirmed",
        preflightCommitment: "confirmed",
      });
    console.log("Init vote computation definition transaction", transactionSignature);

    if (uploadRawCircuit) {
      const rawCircuit = await fs.readFile("build/vote.arcis");

      await uploadCircuit(
        provider as anchor.AnchorProvider,
        "vote",
        program.programId,
        rawCircuit,
        true
      );
    } else if (!offchainSource) {
      const finalizeTx = await buildFinalizeCompDefTx(
        provider as anchor.AnchorProvider,
        Buffer.from(offset).readUInt32LE(),
        program.programId
      );

      const latestBlockhash = await provider.connection.getLatestBlockhash();
      finalizeTx.recentBlockhash = latestBlockhash.blockhash;
      finalizeTx.lastValidBlockHeight = latestBlockhash.lastValidBlockHeight;

      finalizeTx.sign(pollAuthority);

      await provider.sendAndConfirm(finalizeTx);
    }
    return transactionSignature;
  }

  const initRevealResultCompDef = async (
    program: Program<Election>,
    pollAuthority: anchor.web3.Keypair,
    uploadRawCircuit: boolean,
    offchainSource: boolean
  ): Promise<string> => {
    const baseSeedCompDefAcc = getArciumAccountBaseSeed(
      "ComputationDefinitionAccount"
    );
    const offset = getCompDefAccOffset("reveal_result");

    const compDefPDA = PublicKey.findProgramAddressSync(
      [baseSeedCompDefAcc, program.programId.toBuffer(), offset],
      getArciumProgAddress()
    )[0];

    console.log(
      "Reveal result computation definition pda is ",
      compDefPDA.toBase58()
    );

    const transactionSignature = await program.methods
      .initRevealResultCompDef()
      .accounts({
        compDefAccount: compDefPDA,
        payer: pollAuthority.publicKey,
        mxeAccount: getMXEAccAddress(program.programId),
      })
      .signers([pollAuthority])
      .rpc({
        commitment: "confirmed",
        preflightCommitment: "confirmed",
      });
    console.log("Init reveal result computation definition transaction", transactionSignature);

    if (uploadRawCircuit) {
      const rawCircuit = await fs.readFile("build/reveal_result.arcis");

      await uploadCircuit(
        provider as anchor.AnchorProvider,
        "reveal_result",
        program.programId,
        rawCircuit,
        true
      );
    } else if (!offchainSource) {
      const finalizeTx = await buildFinalizeCompDefTx(
        provider as anchor.AnchorProvider,
        Buffer.from(offset).readUInt32LE(),
        program.programId
      );

      const latestBlockhash = await provider.connection.getLatestBlockhash();
      finalizeTx.recentBlockhash = latestBlockhash.blockhash;
      finalizeTx.lastValidBlockHeight = latestBlockhash.lastValidBlockHeight;

      finalizeTx.sign(pollAuthority);

      await provider.sendAndConfirm(finalizeTx);
    }
    return transactionSignature;
  }
});




