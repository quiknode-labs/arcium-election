import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Keypair, PublicKey } from "@solana/web3.js";
import { Voting } from "../target/types/voting";
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
import { getKeypairFromFile } from "@solana-developers/helpers"
import { describe, test, before } from "node:test";
import assert from "node:assert";
import { getRandomBigNumber, makeClientSideKeys, awaitEvent } from "./helpers";

describe("Voting", () => {
  // Configure the client to use the local cluster.
  anchor.setProvider(anchor.AnchorProvider.env());
  const program = anchor.workspace.Voting as Program<Voting>;
  const provider = anchor.getProvider();

  const arciumEnv = getArciumEnv();

  // The Poll IDs we're going to create
  const pollIds = [420, 421, 422];

  // Vote options enum: 0 = Neo robot, 1 = Humane AI PIN, 2 = friend.com
  enum VoteOption {
    NeoRobot = 0,
    HumaneAIPIN = 1,
    FriendCom = 2,
  }

  const OPTION_NAMES: Array<string> = ["Neo robot", "Humane AI PIN", "friend.com"];

  const getOptionName = (index: number): string => OPTION_NAMES[index] ?? `Option ${index}`;

  // Owner keypair for creating polls and initializing computation definitions
  let owner: anchor.web3.Keypair;

  before(async () => {
    owner = await getKeypairFromFile(`${os.homedir()}/.config/solana/id.json`);

    // Computation definitions are persistent on-chain PDAs that register encrypted instructions
    // (like "vote", "init_vote_stats", "reveal_result"). They must be initialized ONCE per
    // deployment/test session. Re-initializing them in the same session would cause "account
    // already in use" errors since the accounts already exist on-chain. This setup is separate
    // from test logic and only needs to happen once before running any tests.
    await initVoteStatsCompDef(program, owner, false, false);
    await initVoteCompDef(program, owner, false, false);
    await initRevealResultCompDef(program, owner, false, false);

    // Create multiple polls (owner creates them) before tests run.
    // Polls are on-chain accounts that persist, so they're created once and reused across tests.
    // This setup phase creates all polls that will be used in the voting tests.
    for (const pollId of pollIds) {
      const pollNonce = randomBytes(16);

      const pollComputationOffset = getRandomBigNumber();

      const createPollSignature = await program.methods
        .createNewPoll(
          pollComputationOffset,
          pollId,
          `Poll ${pollId}: $SOL to 500?`,
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
            Buffer.from(getCompDefAccOffset("init_vote_stats")).readUInt32LE()
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
    }
    console.log("✅ Polls created");
  });

  test("users can vote on polls!", async () => {



    // Define votes for each user
    // Users can vote the same choice across multiple polls
    // Poll 420: Alice votes NeoRobot, Bob votes NeoRobot, Carol votes HumaneAIPIN
    //   Expected: NeoRobot wins (2 votes)
    // Poll 421: Alice votes HumaneAIPIN, Bob votes FriendCom, Carol votes HumaneAIPIN
    //   Expected: HumaneAIPIN wins (2 votes)
    // Poll 422: Alice votes NeoRobot, Bob votes NeoRobot, Carol votes FriendCom
    //   Expected: NeoRobot wins (2 votes)
    const alicePollsAndChoices = [
      { pollId: 420, choice: VoteOption.NeoRobot },
      { pollId: 421, choice: VoteOption.HumaneAIPIN },
      { pollId: 422, choice: VoteOption.NeoRobot },
    ];

    const bobPollsAndChoices = [
      { pollId: 420, choice: VoteOption.NeoRobot },
      { pollId: 421, choice: VoteOption.FriendCom },
      { pollId: 422, choice: VoteOption.NeoRobot },
    ];

    const carolPollsAndChoices = [
      { pollId: 420, choice: VoteOption.HumaneAIPIN },
      { pollId: 421, choice: VoteOption.HumaneAIPIN },
      { pollId: 422, choice: VoteOption.FriendCom },
    ];

    // Calculate expected outcomes based on majority vote from alice, bob, and carol
    const calculateExpectedOutcome = (
      aliceChoice: number,
      bobChoice: number,
      carolChoice: number
    ): number => {
      const votes = [aliceChoice, bobChoice, carolChoice];
      const counts: Array<number> = [0, 0, 0];
      votes.forEach((vote) => {
        counts[vote]++;
      });
      // Return the index with the highest count
      // TODO: Handle tie votes - currently returns the first option with max votes in case of ties
      const maxCount = Math.max(...counts);
      return counts.indexOf(maxCount);
    };

    const expectedOutcomes = pollIds.map((pollId) => {
      const aliceVote = alicePollsAndChoices.find((alicePollAndChoice) => alicePollAndChoice.pollId === pollId)!.choice;
      const bobVote = bobPollsAndChoices.find((bobPollAndChoice) => bobPollAndChoice.pollId === pollId)!.choice;
      const carolVote = carolPollsAndChoices.find((carolPollAndChoice) => carolPollAndChoice.pollId === pollId)!.choice;
      return {
        pollId,
        expectedOutcome: calculateExpectedOutcome(aliceVote, bobVote, carolVote),
      };
    });

    // Create separate users: alice, bob, and carol
    const alice = Keypair.generate();
    const bob = Keypair.generate();
    const carol = Keypair.generate();

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
          authority: owner.publicKey,
        })
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
    for (const { pollId, choice } of alicePollsAndChoices) {
      await castVote(alice, "Alice", pollId, choice, aliceCipher, aliceKeys.publicKey);
    }

    // Bob votes second
    for (const { pollId, choice } of bobPollsAndChoices) {
      await castVote(bob, "Bob", pollId, choice, bobCipher, bobKeys.publicKey);
    }

    // Carol votes third
    for (const { pollId, choice } of carolPollsAndChoices) {
      await castVote(carol, "Carol", pollId, choice, carolCipher, carolKeys.publicKey);
    }

    // Reveal results for each poll and verify against expected outcomes
    for (const { pollId, expectedOutcome } of expectedOutcomes) {

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
    }
  });

  const initVoteStatsCompDef = async (
    program: Program<Voting>,
    owner: anchor.web3.Keypair,
    uploadRawCircuit: boolean,
    offchainSource: boolean
  ): Promise<string> => {
    const baseSeedCompDefAcc = getArciumAccountBaseSeed(
      "ComputationDefinitionAccount"
    );
    const offset = getCompDefAccOffset("init_vote_stats");

    const compDefPDA = PublicKey.findProgramAddressSync(
      [baseSeedCompDefAcc, program.programId.toBuffer(), offset],
      getArciumProgAddress()
    )[0];

    console.log(
      "Init vote stats computation definition pda is ",
      compDefPDA.toBase58()
    );

    const transactionSignature = await program.methods
      .initVoteStatsCompDef()
      .accounts({
        compDefAccount: compDefPDA,
        payer: owner.publicKey,
        mxeAccount: getMXEAccAddress(program.programId),
      })
      .signers([owner])
      .rpc({
        commitment: "confirmed",
        preflightCommitment: "confirmed",
      });
    console.log("Init vote stats computation definition transaction", transactionSignature);

    if (uploadRawCircuit) {
      const rawCircuit = await fs.readFile("build/init_vote_stats.arcis");

      await uploadCircuit(
        provider as anchor.AnchorProvider,
        "init_vote_stats",
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

      finalizeTx.sign(owner);

      await provider.sendAndConfirm(finalizeTx);
    }
    return transactionSignature;
  }

  const initVoteCompDef = async (
    program: Program<Voting>,
    owner: anchor.web3.Keypair,
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
        payer: owner.publicKey,
        mxeAccount: getMXEAccAddress(program.programId),
      })
      .signers([owner])
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

      finalizeTx.sign(owner);

      await provider.sendAndConfirm(finalizeTx);
    }
    return transactionSignature;
  }

  const initRevealResultCompDef = async (
    program: Program<Voting>,
    owner: anchor.web3.Keypair,
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
        payer: owner.publicKey,
        mxeAccount: getMXEAccAddress(program.programId),
      })
      .signers([owner])
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

      finalizeTx.sign(owner);

      await provider.sendAndConfirm(finalizeTx);
    }
    return transactionSignature;
  }
});




