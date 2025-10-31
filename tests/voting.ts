import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
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
import { describe, it } from "node:test";
import assert from "node:assert";
import { getRandomBigNumber, makeClientSideKeys } from "./helpers";

describe("Voting", () => {
  // Configure the client to use the local cluster.
  anchor.setProvider(anchor.AnchorProvider.env());
  const program = anchor.workspace.Voting as Program<Voting>;
  const provider = anchor.getProvider();

  type Event = anchor.IdlEvents<(typeof program)["idl"]>;
  const awaitEvent = async <E extends keyof Event>(eventName: E) => {
    let listenerId: number;
    const event = await new Promise<Event[E]>((resolve) => {
      listenerId = program.addEventListener(eventName, (event) => {
        resolve(event);
      });
    });
    await program.removeEventListener(listenerId);

    return event;
  };

  const arciumEnv = getArciumEnv();


  it("users can vote on polls!", async () => {
    // Vote options: 0 = Neo robot, 1 = Humane AI PIN, 2 = friend.com
    const pollsAndChoices = [
      { pollId: 420, choice: 0 }, // Neo robot
      { pollId: 421, choice: 1 }, // Humane AI PIN
      { pollId: 422, choice: 2 }, // friend.com
    ];

    const owner = await getKeypairFromFile(`${os.homedir()}/.config/solana/id.json`);

    const { privateKey, publicKey, sharedSecret } = await makeClientSideKeys(provider as anchor.AnchorProvider, program.programId);

    console.log("Initializing vote stats computation definition");
    const initVoteStatsSignature = await initVoteStatsCompDef(
      program,
      owner,
      false,
      false
    );
    console.log(
      "Vote stats computation definition initialized with signature",
      initVoteStatsSignature
    );

    console.log("Initializing voting computation definition");
    const initVoteSignature = await initVoteCompDef(program, owner, false, false);
    console.log(
      "Vote computation definition initialized with signature",
      initVoteSignature
    );

    console.log("Initializing reveal result computation definition");
    const initRevealResultSignature = await initRevealResultCompDef(
      program,
      owner,
      false,
      false
    );
    console.log(
      "Reveal result computation definition initialized with signature",
      initRevealResultSignature
    );


    const cipher = new RescueCipher(sharedSecret);

    // Create multiple polls
    for (const { pollId } of pollsAndChoices) {
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

    // Cast votes for each poll for different outcomes
    const optionNames = ["Neo robot", "Humane AI PIN", "friend.com"];

    for (const { pollId, choice } of pollsAndChoices) {
      const plaintext = [BigInt(choice)];

      const nonce = randomBytes(16);
      const ciphertext = cipher.encrypt(plaintext, nonce);

      console.log(`Voting for poll ${pollId}: ${optionNames[choice]}`);

      const voteComputationOffset = getRandomBigNumber();

      // Needs to be awaited before queueing the vote
      const voteEventPromise = awaitEvent("voteEvent");

      const queueVoteSignature = await program.methods
        .vote(
          voteComputationOffset,
          pollId,
          Array.from(ciphertext[0]),
          Array.from(publicKey),
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
      console.log(`Queue vote for poll ${pollId} signature is `, queueVoteSignature);

      const finalizeVoteSignature = await awaitComputationFinalization(
        provider as anchor.AnchorProvider,
        voteComputationOffset,
        program.programId,
        "confirmed"
      );
      console.log(`Finalize vote for poll ${pollId} signature is `, finalizeVoteSignature);

      const voteEvent = await voteEventPromise;
      console.log(
        `🗳️ Voted ${optionNames[choice]} (${choice}) for poll ${pollId} at timestamp `,
        voteEvent.timestamp.toString()
      );
    }

    // Reveal results for each poll
    for (const { pollId, choice: expectedOutcome } of pollsAndChoices) {

      const revealEventPromise = awaitEvent("revealResultEvent");

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
      console.log(`Reveal queue for poll ${pollId} signature is `, revealQueueSignature);

      const revealFinalizeSignature = await awaitComputationFinalization(
        provider as anchor.AnchorProvider,
        revealComputationOffset,
        program.programId,
        "confirmed"
      );
      console.log(
        `Reveal finalize for poll ${pollId} signature is `,
        revealFinalizeSignature
      );

      const revealEvent = await revealEventPromise;
      console.log(
        `🏆 Decrypted winner for poll ${pollId} is ${optionNames[revealEvent.output]} (${revealEvent.output})`
      );
      assert.equal(revealEvent.output, expectedOutcome);
    }
  });

  async function initVoteStatsCompDef(
    program: Program<Voting>,
    owner: anchor.web3.Keypair,
    uploadRawCircuit: boolean,
    offchainSource: boolean
  ): Promise<string> {
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

  async function initVoteCompDef(
    program: Program<Voting>,
    owner: anchor.web3.Keypair,
    uploadRawCircuit: boolean,
    offchainSource: boolean
  ): Promise<string> {
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

  async function initRevealResultCompDef(
    program: Program<Voting>,
    owner: anchor.web3.Keypair,
    uploadRawCircuit: boolean,
    offchainSource: boolean
  ): Promise<string> {
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




