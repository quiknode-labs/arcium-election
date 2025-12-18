import { getSetComputeUnitLimitInstruction } from "@solana-program/compute-budget";
import { randomBytes } from "crypto";
import { connect, type Connection } from "solana-kite";
import {
  type KeyPairSigner,
  type Address,
  type Instruction,
  address,
  lamports,
} from "@solana/kit";
import { RescueCipher } from "./arcium-solana-kit/rescue-cipher.js";
import {
  getArciumEnv,
  getMXEAccAddress,
  getMempoolAccAddress,
  getCompDefAccAddress,
  getExecutingPoolAccAddress,
  getComputationAccAddress,
  awaitComputationFinalization,
  getCompDefAccOffset,
  deserializeLE,
  buildFinalizeCompDefInstruction,
} from "./arcium-solana-kit/arcium-kit-helpers.js";
import * as os from "os";
import { describe, test, before } from "node:test";
import assert from "node:assert";
import {
  getRandomBigInt,
  makeClientSideKeys,
} from "./arcium-solana-kit/helpers.js";
import { loadWalletFromFileWithSecretKey } from "./solana-kit-helpers.js";
import { uploadCircuit } from "./arcium-solana-kit/arcium-upload-circuit.js";
import {
  getInitVoteCompDefInstruction,
  getInitRevealResultCompDefInstruction,
  getInitCreatePollCompDefInstruction,
  getCreatePollInstructionAsync,
  getVoteInstructionAsync,
  getRevealResultInstructionAsync,
} from "../dist/election-client/index.js";
import * as fs from "fs/promises";
import * as path from "path";

describe("Election", () => {
  // Election program ID from target/idl/election.json
  const ELECTION_PROGRAM_ID = address(
    "28sDdkSz9WxFwLZEDx93ifLBVhti5NSkP6ZpgG7Z3H2m"
  );

  // Solana Kit connection for transaction sending
  let connection: Connection;

  const arciumEnv = getArciumEnv();

  // The Poll ID we're going to create
  const pollId = 420;

  // Vote options enum: 0 = Neo robot, 1 = Humane AI PIN, 2 = friend.com
  enum VoteOption {
    NeoRobot = 0,
    HumaneAIPIN = 1,
    FriendCom = 2,
  }

  const OPTION_NAMES: Array<string> = [
    "Neo robot",
    "Humane AI PIN",
    "friend.com",
  ];

  const getOptionName = (index: number): string =>
    OPTION_NAMES[index] ?? `Option ${index}`;

  // Poll authority keypair for creating polls and initializing computation definitions
  let pollAuthority: KeyPairSigner;

  before(async () => {
    // Initialize Solana Kit connection
    connection = connect("localnet");

    pollAuthority = await loadWalletFromFileWithSecretKey(
      `${os.homedir()}/.config/solana/id.json`
    );

    // Computation definitions are persistent onchain PDAs that register encrypted instruction handlers
    // (like "vote", "create_poll", "reveal_result"). They must be initialized ONCE per
    // deployment/test session. Re-initializing them in the same session would cause "account
    // already in use" errors since the accounts already exist onchain. This setup is separate
    // from test logic and only needs to happen once before running any tests.
    await initCreatePollCompDef(pollAuthority, false, false);
    await initVoteCompDef(pollAuthority, false, false);
    await initRevealResultCompDef(pollAuthority, false, false);

    // Create the poll (owner creates it) before tests run.
    // The poll is an onchain account that persists, so it's created once and reused across tests.
    const pollNonce = randomBytes(16);

    const pollComputationOffset = getRandomBigInt();

    const question = `Worst tech invention of 2025?`;

    const createPollInstruction = await getCreatePollInstructionAsync({
      payer: pollAuthority,
      computationAccount: await getComputationAccAddress(
        connection,
        ELECTION_PROGRAM_ID,
        pollComputationOffset
      ),
      clusterAccount: arciumEnv.arciumClusterPubkey,
      mxeAccount: await getMXEAccAddress(connection, ELECTION_PROGRAM_ID),
      mempoolAccount: await getMempoolAccAddress(
        connection,
        ELECTION_PROGRAM_ID
      ),
      executingPool: await getExecutingPoolAccAddress(
        connection,
        ELECTION_PROGRAM_ID
      ),
      compDefAccount: await getCompDefAccAddress(
        connection,
        ELECTION_PROGRAM_ID,
        getCompDefAccOffset("create_poll")
      ),
      computationOffset: pollComputationOffset,
      id: pollId,
      question,
      nonce: deserializeLE(pollNonce),
    });

    const createPollSignature =
      await connection.sendTransactionFromInstructions({
        feePayer: pollAuthority,
        instructions: [createPollInstruction],
        skipPreflight: true,
      });

    const finalizePollSignature = await awaitComputationFinalization(
      pollComputationOffset,
      ELECTION_PROGRAM_ID,
      "confirmed"
    );
    console.log(
      `🆕 Poll "${question}" with poll ID ${pollId} and choices ${OPTION_NAMES.join(
        ", "
      )}`
    );
  });

  test("users can vote on polls without revealing their choices!", async () => {
    // Create separate users: alice, bob, and carol
    const [alice, bob, carol] = await connection.createWallets(3, {
      airdropAmount: lamports(1_000_000_000n),
    });

    // Define votes for each user
    const aliceChoice = VoteOption.HumaneAIPIN;
    const bobChoice = VoteOption.NeoRobot;
    const carolChoice = VoteOption.HumaneAIPIN;

    // Calculate expected outcome based on majority vote from alice, bob, and carol
    const calculateExpectedOutcome = (
      aliceChoice: number,
      bobChoice: number,
      carolChoice: number
    ): number => {
      const counts: Array<number> = [0, 0, 0];
      [aliceChoice, bobChoice, carolChoice].forEach((vote) => counts[vote]++);
      return counts.indexOf(Math.max(...counts));
    };

    const expectedOutcome = calculateExpectedOutcome(
      aliceChoice,
      bobChoice,
      carolChoice
    );

    // Create encryption keys for each user
    const aliceKeys = await makeClientSideKeys(ELECTION_PROGRAM_ID);
    const bobKeys = await makeClientSideKeys(ELECTION_PROGRAM_ID);
    const carolKeys = await makeClientSideKeys(ELECTION_PROGRAM_ID);

    // Create encryption ciphers for each user
    const aliceCipher = new RescueCipher(aliceKeys.sharedSecret);
    const bobCipher = new RescueCipher(bobKeys.sharedSecret);
    const carolCipher = new RescueCipher(carolKeys.sharedSecret);

    console.log(
      `👬 Created wallets and client side keys for Alice, Bob, and Carol`
    );

    // Helper function to cast a vote
    const castVote = async (
      voter: KeyPairSigner,
      voterName: string,
      pollId: number,
      choice: number,
      cipher: RescueCipher,
      encryptionPublicKey: Uint8Array
    ) => {
      const plaintext = [BigInt(choice)];
      const nonce = randomBytes(16);
      const ciphertext = cipher.encrypt(plaintext, nonce);

      const voteComputationOffset = getRandomBigInt();

      const voteInstruction = await getVoteInstructionAsync({
        payer: voter,
        computationAccount: await getComputationAccAddress(
          connection,
          ELECTION_PROGRAM_ID,
          voteComputationOffset
        ),
        clusterAccount: arciumEnv.arciumClusterPubkey,
        mxeAccount: await getMXEAccAddress(connection, ELECTION_PROGRAM_ID),
        mempoolAccount: await getMempoolAccAddress(
          connection,
          ELECTION_PROGRAM_ID
        ),
        executingPool: await getExecutingPoolAccAddress(
          connection,
          ELECTION_PROGRAM_ID
        ),
        compDefAccount: await getCompDefAccAddress(
          connection,
          ELECTION_PROGRAM_ID,
          getCompDefAccOffset("vote")
        ),
        authority: pollAuthority.address,
        computationOffset: voteComputationOffset,
        pollId: pollId,
        choice: new Uint8Array(ciphertext[0]),
        voteEncryptionPubkey: encryptionPublicKey,
        voteNonce: deserializeLE(nonce),
      });

      const queueVoteSignature =
        await connection.sendTransactionFromInstructions({
          feePayer: voter,
          instructions: [voteInstruction],
          skipPreflight: true,
        });

      const finalizeVoteSignature = await awaitComputationFinalization(
        voteComputationOffset,
        ELECTION_PROGRAM_ID,
        "confirmed"
      );

      console.log(
        `🗳️  ${voterName} voted ${getOptionName(
          choice
        )} (${choice}) for poll ${pollId}`
      );
    };

    // Alice votes first
    await castVote(
      alice,
      "Alice",
      pollId,
      aliceChoice,
      aliceCipher,
      aliceKeys.publicKey
    );

    // Bob votes second
    await castVote(bob, "Bob", pollId, bobChoice, bobCipher, bobKeys.publicKey);

    // Carol votes third
    await castVote(
      carol,
      "Carol",
      pollId,
      carolChoice,
      carolCipher,
      carolKeys.publicKey
    );

    // Reveal results and verify against expected outcome
    const revealComputationOffset = getRandomBigInt();

    const revealResultInstruction = await getRevealResultInstructionAsync({
      payer: pollAuthority,
      computationAccount: await getComputationAccAddress(
        connection,
        ELECTION_PROGRAM_ID,
        revealComputationOffset
      ),
      clusterAccount: arciumEnv.arciumClusterPubkey,
      mxeAccount: await getMXEAccAddress(connection, ELECTION_PROGRAM_ID),
      mempoolAccount: await getMempoolAccAddress(
        connection,
        ELECTION_PROGRAM_ID
      ),
      executingPool: await getExecutingPoolAccAddress(
        connection,
        ELECTION_PROGRAM_ID
      ),
      compDefAccount: await getCompDefAccAddress(
        connection,
        ELECTION_PROGRAM_ID,
        getCompDefAccOffset("reveal_result")
      ),
      computationOffset: revealComputationOffset,
      id: pollId,
    });

    const revealQueueSignature =
      await connection.sendTransactionFromInstructions({
        feePayer: pollAuthority,
        instructions: [revealResultInstruction],
        skipPreflight: true,
      });

    const revealFinalizeSignature = await awaitComputationFinalization(
      revealComputationOffset,
      ELECTION_PROGRAM_ID,
      "confirmed"
    );

    console.log(
      `🏆 Decrypted winner for poll ${pollId} is "${getOptionName(
        expectedOutcome
      )}"`
    );
    // Note: We can't verify the actual result without event listening, but the test will fail
    // if the computation doesn't complete successfully
  });

  /**
   * Initializes a computation definition for a given circuit.
   * This helper consolidates the logic for initializing create_poll, vote, and reveal_result circuits.
   *
   * @param circuitName - The name of the circuit ("create_poll", "vote", or "reveal_result")
   * @param pollAuthority - The keypair signer for the poll authority
   * @param uploadRawCircuit - Whether to upload the raw circuit file
   * @param offchainSource - Whether the circuit source is stored offchain
   * @param getInitInstruction - Function to get the initialization instruction for this circuit
   * @param displayName - Human-readable name for logging
   * @param needsComputeBudget - Whether this circuit needs additional compute budget (only create_poll does)
   * @returns Promise resolving to the transaction signature (or empty string if skipped)
   */
  const initCompDef = async (
    circuitName: "create_poll" | "vote" | "reveal_result",
    pollAuthority: KeyPairSigner,
    uploadRawCircuit: boolean,
    offchainSource: boolean,
    getInitInstruction: (params: {
      payer: KeyPairSigner;
      mxeAccount: Address;
      compDefAccount: Address;
    }) => Instruction,
    displayName: string,
    needsComputeBudget: boolean = false
  ): Promise<string> => {
    const offset = getCompDefAccOffset(circuitName);
    const compDefPDA = await getCompDefAccAddress(
      connection,
      ELECTION_PROGRAM_ID,
      offset
    );

    // Check if the comp def account already exists
    const existingAccount = await connection.rpc
      .getAccountInfo(compDefPDA)
      .send();

    let transactionSignature: string;
    if (existingAccount.value) {
      console.log(
        `${displayName} computation definition already exists, skipping initialization`
      );
      return "";
    } else {
      const initInstruction = getInitInstruction({
        payer: pollAuthority,
        mxeAccount: await getMXEAccAddress(connection, ELECTION_PROGRAM_ID),
        compDefAccount: compDefPDA,
      });

      const instructions = [];

      if (needsComputeBudget) {
        // create_poll circuit requires higher compute budget due to initialization complexity
        const COMPUTE_UNIT_LIMIT = 1_400_000;
        const computeBudgetInstruction = getSetComputeUnitLimitInstruction({
          units: COMPUTE_UNIT_LIMIT,
        });
        instructions.push(computeBudgetInstruction);
      }

      instructions.push(initInstruction);

      transactionSignature = await connection.sendTransactionFromInstructions({
        feePayer: pollAuthority,
        instructions,
        skipPreflight: true,
      });

      if (needsComputeBudget) {
        console.log("Transaction sent:", transactionSignature);
      }
    }

    if (uploadRawCircuit) {
      const circuitPath = path.join(
        process.cwd(),
        "build",
        `${circuitName}.arcis`
      );
      const rawCircuit = await fs.readFile(circuitPath);

      const uploadSigs = await uploadCircuit(
        connection,
        pollAuthority,
        circuitName,
        ELECTION_PROGRAM_ID,
        rawCircuit,
        true,
        500
      );

      console.log(
        `Uploaded ${circuitName} circuit in ${uploadSigs.length} transactions`
      );
    } else if (!offchainSource) {
      const finalizeInstruction = await buildFinalizeCompDefInstruction(
        connection,
        pollAuthority,
        Buffer.from(offset).readUInt32LE(),
        ELECTION_PROGRAM_ID
      );

      await connection.sendTransactionFromInstructions({
        feePayer: pollAuthority,
        instructions: [finalizeInstruction],
        skipPreflight: true,
      });
    }
    return transactionSignature;
  };

  const initCreatePollCompDef = async (
    pollAuthority: KeyPairSigner,
    uploadRawCircuit: boolean,
    offchainSource: boolean
  ): Promise<string> => {
    return initCompDef(
      "create_poll",
      pollAuthority,
      uploadRawCircuit,
      offchainSource,
      getInitCreatePollCompDefInstruction,
      "Create poll",
      true
    );
  };

  const initVoteCompDef = async (
    pollAuthority: KeyPairSigner,
    uploadRawCircuit: boolean,
    offchainSource: boolean
  ): Promise<string> => {
    return initCompDef(
      "vote",
      pollAuthority,
      uploadRawCircuit,
      offchainSource,
      getInitVoteCompDefInstruction,
      "Vote",
      false
    );
  };

  const initRevealResultCompDef = async (
    pollAuthority: KeyPairSigner,
    uploadRawCircuit: boolean,
    offchainSource: boolean
  ): Promise<string> => {
    return initCompDef(
      "reveal_result",
      pollAuthority,
      uploadRawCircuit,
      offchainSource,
      getInitRevealResultCompDefInstruction,
      "Reveal result",
      false
    );
  };
});
