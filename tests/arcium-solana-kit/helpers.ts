import { x25519 } from "@noble/curves/ed25519";
import { type Address, type KeyPairSigner, type Instruction, AccountRole } from "@solana/kit";
import { connect, type Connection } from "solana-kite";
import { setTimeout } from "timers/promises";
import { randomBytes, createHash } from "crypto";
import bs58 from "bs58";
import { readFile } from "fs/promises";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import {
  ARCIUM_PROGRAM_ID,
  MXE_ACCOUNT_SEED,
  COMPUTATION_ACCOUNT_SEED,
  COMPUTATION_DEFINITION_ACCOUNT_SEED,
  COMPUTATION_DEFINITION_RAW_SEED,
} from "./constants.js";

const currentDir = dirname(fileURLToPath(import.meta.url));
const arciumIdlPath = join(currentDir, "arcium.json");
const arciumIdl = JSON.parse(await readFile(arciumIdlPath, "utf-8"));

/**
 * All Arcium helper functions for working with Solana Kit.
 * Re-implementation of @arcium-hq/client without web3.js dependency.
 * Updated for Arcium 0.6.3
 */

const MEMPOOL_SEED = "Mempool";
const EXECUTING_POOL_SEED = "Execpool";

/**
 * Arcium transaction constants extracted from the Arcium IDL.
 * These values define limits for circuit upload and account reallocation operations.
 */

const uploadCircuitInstruction = (arciumIdl as any).instructions.find(
  (ix: any) => ix.name === "upload_circuit"
);
if (!uploadCircuitInstruction) {
  throw new Error("upload_circuit instruction not found in Arcium IDL");
}

const uploadDataArg = uploadCircuitInstruction.args.find(
  (arg: any) => arg.name === "upload_data"
);
if (!uploadDataArg || !uploadDataArg.type?.array || !Array.isArray(uploadDataArg.type.array)) {
  throw new Error("upload_data argument not found or invalid in Arcium IDL");
}

export const MAX_UPLOAD_PER_TX_BYTES = uploadDataArg.type.array[1] as number;
export const MAX_REALLOC_PER_IX = 10240;
export const MAX_ACCOUNT_SIZE = 10485760;
export const MAX_EMBIGGEN_IX_PER_TX = 18;

/**
 * Get Arcium cluster offset from environment variable
 */
export const getArciumClusterOffset = (): number => {
  const arciumClusterOffsetString = process.env.ARCIUM_CLUSTER_OFFSET;

  if (!arciumClusterOffsetString) {
    throw new Error('ARCIUM_CLUSTER_OFFSET environment variable is not set');
  }

  const arciumClusterOffset = Number(arciumClusterOffsetString);
  if (isNaN(arciumClusterOffset)) {
    throw new Error('ARCIUM_CLUSTER_OFFSET must be a valid integer');
  }

  return arciumClusterOffset;
};

/**
 * Derives the MXE PDA address for a given program.
 *
 * @param connection - The Kite connection
 * @param programId - The MXE program ID
 * @returns The MXE account address
 */
export const getMXEAccountAddress = async (
  connection: Connection,
  programId: Address
): Promise<Address> => {
  const result = await connection.getPDAAndBump(ARCIUM_PROGRAM_ID, [
    MXE_ACCOUNT_SEED,
    programId,
  ]);
  return result.pda;
};

/**
 * Fetches the MXE public key with retry logic using Solana Kit.
 * Re-implementation of @arcium-hq/client's getMXEPublicKey without web3.js.
 *
 * Parses the MXEAccount based on Arcium IDL structure:
 * - discriminator: 8 bytes
 * - cluster: Option<u32> = 1 byte discriminator + 4 bytes if Some
 * - keygen_offset: u64 = 8 bytes
 * - key_recovery_init_offset: u64 = 8 bytes
 * - mxe_program_id: Pubkey = 32 bytes
 * - authority: Option<Pubkey> = 1 byte discriminator + 32 bytes if Some
 * - utility_pubkeys: SetUnset<UtilityPubkeys>
 *   - Set(UtilityPubkeys): variant 0 + UtilityPubkeys (160 bytes)
 *   - Unset(UtilityPubkeys, Vec<bool>): variant 1 + UtilityPubkeys (160 bytes) + Vec<bool>
 *   - UtilityPubkeys struct (160 bytes total):
 *     - x25519_pubkey: [u8; 32]
 *     - ed25519_verifying_key: [u8; 32]
 *     - elgamal_pubkey: [u8; 32]
 *     - pubkey_validity_proof: [u8; 64]
 *
 * @param programId - The MXE program ID as an Address
 * @param maxRetries - Maximum number of retry attempts
 * @param retryDelayMs - Delay between retries in milliseconds
 * @returns The MXE's x25519 public key as a Uint8Array
 */
export const getMXEPublicKeyWithRetry = async (
  programId: Address,
  maxRetries: number = 20,
  retryDelayMs: number = 500
): Promise<Uint8Array> => {
  const connection = connect("localnet");
  const mxeAccAddress = await getMXEAccountAddress(connection, programId);

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const accountInfo = await connection.rpc.getAccountInfo(mxeAccAddress, {
        encoding: "base64",
      }).send();

      if (!accountInfo.value) {
        throw new Error(`MXE account not found at ${mxeAccAddress}`);
      }

      const accountData = Buffer.from(accountInfo.value.data[0], "base64");

      let offset = 8;

      offset += 1;
      if (accountData[offset - 1] === 1) {
        offset += 4;
      }

      offset += 8;
      offset += 8;
      offset += 32;

      const authorityOption = accountData[offset];
      offset += 1;
      if (authorityOption === 1) {
        offset += 32;
      }

      const utilityPubkeysVariant = accountData[offset];
      offset += 1;

      const x25519Pubkey = accountData.subarray(offset, offset + 32);

      if (utilityPubkeysVariant === 0) {
        return new Uint8Array(x25519Pubkey);
      } else if (utilityPubkeysVariant === 1) {
        const utilityPubkeysSize = 160;
        const vecBoolOffset = offset + utilityPubkeysSize;
        const vecLength = accountData.readUInt32LE(vecBoolOffset);
        const boolsOffset = vecBoolOffset + 4;

        let allTrue = true;
        for (let i = 0; i < vecLength; i++) {
          if (accountData[boolsOffset + i] === 0) {
            allTrue = false;
            break;
          }
        }

        if (allTrue) {
          return new Uint8Array(x25519Pubkey);
        } else {
          throw new Error("MXE utility pubkeys are not fully initialized yet");
        }
      } else {
        throw new Error(`Invalid SetUnset variant: ${utilityPubkeysVariant}`);
      }
    } catch (error) {
      console.log(`Attempt ${attempt} failed to fetch MXE public key:`, error);
    }

    if (attempt < maxRetries) {
      console.log(
        `Retrying in ${retryDelayMs}ms... (attempt ${attempt}/${maxRetries})`
      );
      await setTimeout(retryDelayMs);
    }
  }

  throw new Error(
    `Failed to fetch MXE public key after ${maxRetries} attempts`
  );
};

/**
 * Generates client-side encryption keys for Arcium confidential computing.
 */
export const makeClientSideKeys = async (programId: Address) => {
  const mxePublicKey = await getMXEPublicKeyWithRetry(programId);

  const privateKey = x25519.utils.randomSecretKey();
  const publicKey = x25519.getPublicKey(privateKey);
  const sharedSecret = x25519.getSharedSecret(privateKey, mxePublicKey);

  return {
    privateKey,
    publicKey,
    sharedSecret,
  };
};

/**
 * Generates a random nonce for encryption operations.
 */
export const getRandomNonce = (): Uint8Array => {
  return new Uint8Array(randomBytes(12));
};

/**
 * Deserializes a little-endian byte array to a BigInt.
 * Re-implementation without bn.js dependency.
 */
export const deserializeLE = (bytes: Uint8Array | Buffer): bigint => {
  let result = BigInt(0);
  for (let i = 0; i < bytes.length; i++) {
    result |= BigInt(bytes[i]) << (BigInt(i) * BigInt(8));
  }
  return result;
};

/**
 * Serializes a BigInt to a little-endian byte array of specified length.
 * Helper function for encoding instruction arguments.
 *
 * @param value - The BigInt value to serialize
 * @param length - The desired byte length
 * @returns The serialized value as a Uint8Array
 */
export const serializeLE = (value: bigint, length: number): Uint8Array => {
  const buffer = new Uint8Array(length);
  let remaining = value;
  for (let i = 0; i < length; i++) {
    buffer[i] = Number(remaining & BigInt(0xff));
    remaining >>= BigInt(8);
  }
  return buffer;
};

/**
 * Generates a random bigint from 8 random bytes.
 * Re-implementation without bn.js dependency.
 *
 * @returns A random bigint value
 */
export const getRandomBigInt = (): bigint => {
  const bytes = randomBytes(8);
  return deserializeLE(bytes);
};

/**
 * Derives a PDA for an Arcium account using the Arcium program ID.
 * PDA derivation is a local cryptographic operation that doesn't require network access.
 * @param connection - The Kite connection (just used to access getPDAAndBump method)
 * @param seeds - Array of seeds for PDA derivation
 * @returns Promise resolving to the derived PDA address
 */
const getArciumPDA = async (
  connection: Connection,
  seeds: Array<string | Address | Uint8Array>
): Promise<Address> => {
  const result = await connection.getPDAAndBump(ARCIUM_PROGRAM_ID, seeds);
  return result.pda;
};

const numberToLE8ByteArray = (num: bigint): Uint8Array => {
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setBigUint64(0, num, true);
  return new Uint8Array(buffer);
};

/**
 * Derives the computation account address for a given cluster offset and computation offset.
 * PDA functions use clusterOffset instead of programId.
 * @param connection - The Kite connection
 * @param clusterOffset - The Arcium cluster offset as a number
 * @param computationOffset - The computation offset as a bigint.
 * @returns Promise resolving to the derived computation account address.
 */
export const getComputationAccountAddress = async (
  connection: Connection,
  clusterOffset: number,
  computationOffset: bigint
): Promise<Address> => {
  const clusterOffsetBytes = new Uint8Array(4);
  new DataView(clusterOffsetBytes.buffer).setUint32(0, clusterOffset, true);

  return getArciumPDA(connection, [
    COMPUTATION_ACCOUNT_SEED,
    clusterOffsetBytes,
    numberToLE8ByteArray(computationOffset),
  ]);
};

/**
 * Derives the mempool account address for a given cluster offset.
 * PDA functions use clusterOffset instead of programId.
 * @param connection - The Kite connection
 * @param clusterOffset - The Arcium cluster offset as a number
 * @returns Promise resolving to the derived mempool account address.
 */
export const getMempoolAccountAddress = async (
  connection: Connection,
  clusterOffset: number
): Promise<Address> => {
  const clusterOffsetBytes = new Uint8Array(4);
  new DataView(clusterOffsetBytes.buffer).setUint32(0, clusterOffset, true);

  return getArciumPDA(connection, [MEMPOOL_SEED, clusterOffsetBytes]);
};

/**
 * Derives the executing pool account address for a given cluster offset.
 * PDA functions use clusterOffset instead of programId.
 * @param connection - The Kite connection
 * @param clusterOffset - The Arcium cluster offset as a number
 * @returns Promise resolving to the derived executing pool account address.
 */
export const getExecutingPoolAccountAddress = async (
  connection: Connection,
  clusterOffset: number
): Promise<Address> => {
  const clusterOffsetBytes = new Uint8Array(4);
  new DataView(clusterOffsetBytes.buffer).setUint32(0, clusterOffset, true);

  return getArciumPDA(connection, [EXECUTING_POOL_SEED, clusterOffsetBytes]);
};

/**
 * Derives the cluster account address for a given cluster offset.
 * Gets the cluster account PDA.
 * @param connection - The Kite connection
 * @param clusterOffset - The Arcium cluster offset as a number
 * @returns Promise resolving to the derived cluster account address.
 */
export const getClusterAccountAddress = async (
  connection: Connection,
  clusterOffset: number
): Promise<Address> => {
  const clusterOffsetBytes = new Uint8Array(4);
  new DataView(clusterOffsetBytes.buffer).setUint32(0, clusterOffset, true);

  return getArciumPDA(connection, ["Cluster", clusterOffsetBytes]);
};

/**
 * Derives the computation definition account address for a given MXE program ID and offset.
 * @param connection - The Kite connection
 * @param mxeProgramId - The address string of the MXE program.
 * @param offset - The computation definition offset as a Uint8Array (from getComputationDefinitionAccountOffset).
 * @returns Promise resolving to the derived computation definition account address.
 */
export const getComputationDefinitionAccountAddress = async (
  connection: Connection,
  mxeProgramId: Address,
  offset: Uint8Array
): Promise<Address> => {
  return getArciumPDA(connection, [COMPUTATION_DEFINITION_ACCOUNT_SEED, mxeProgramId, offset]);
};

/**
 * Returns the Arcium program ID.
 * @returns The Arcium program ID.
 */
export const getArciumProgramId = (): Address => {
  return ARCIUM_PROGRAM_ID;
};

/**
 * Gets the base seed for an Arcium account type.
 * @param accName - The account name.
 * @returns The base seed as a Uint8Array.
 */
export const getArciumAccountBaseSeed = (accName: string): Uint8Array => {
  return new TextEncoder().encode(accName);
};

/**
 * Gets the computation definition account offset for a given circuit name.
 * Re-implementation of @arcium-hq/client's getComputationDefinitionAccountOffset without dependencies.
 *
 * This function computes a deterministic offset by hashing the circuit name with SHA256
 * and taking the first 4 bytes. This offset is used as a seed for deriving the
 * computation definition account PDA.
 *
 * @param circuitName - The name of the circuit (e.g., "create_poll", "vote", "reveal_result")
 * @returns The first 4 bytes of the SHA256 hash as a Uint8Array
 */
export const getComputationDefinitionAccountOffset = (circuitName: string): Uint8Array => {
  const hash = createHash('sha256').update(circuitName, 'utf-8').digest();
  return new Uint8Array(hash.slice(0, 4));
};

/**
 * Waits for a computation to be finalized on the Arcium network.
 *
 * This function polls for the FinalizeComputationEvent by checking transaction signatures
 * and their logs for the specific computation offset and MXE program ID.
 *
 * The event discriminator from Arcium IDL: [27, 75, 117, 221, 191, 213, 253, 249]
 * Event structure:
 * - computation_offset: u64
 * - mxe_program_id: pubkey
 *
 * @param computationOffset - The computation offset as a bigint
 * @param mxeProgramId - The MXE program ID as an Address
 * @param commitment - Commitment level (default: "confirmed")
 * @returns Promise resolving to the transaction signature when finalized
 */
export const awaitComputationFinalization = async (
  computationOffset: bigint,
  mxeProgramId: Address,
  commitment: "processed" | "confirmed" | "finalized" = "confirmed"
): Promise<string> => {
  const connection = connect("localnet");

  const offsetBytes = Buffer.from(serializeLE(computationOffset, 8));

  const mxeProgramIdBytes = Buffer.from(bs58.decode(mxeProgramId));

  const pollInterval = 1000;
  const maxAttempts = 120;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const signatures = await connection.rpc.getSignaturesForAddress(
        ARCIUM_PROGRAM_ID,
        { limit: 10 }
      ).send();

      for (const sigInfo of signatures) {
        const tx = await connection.rpc.getTransaction(sigInfo.signature, {
          commitment,
          encoding: "json",
          maxSupportedTransactionVersion: 0,
        }).send();

        if (!tx) continue;

        const logs = tx.meta?.logMessages || [];

        for (const log of logs) {
          if (log.includes('Program data:')) {
            const base64Data = log.split('Program data: ')[1];
            if (!base64Data) continue;

            try {
              const eventData = Buffer.from(base64Data, 'base64');

              if (eventData.length >= 8 + 8 + 32 &&
                  eventData[0] === 27 &&
                  eventData[1] === 75 &&
                  eventData[2] === 117 &&
                  eventData[3] === 221 &&
                  eventData[4] === 191 &&
                  eventData[5] === 213 &&
                  eventData[6] === 253 &&
                  eventData[7] === 249) {

                const eventOffsetBytes = eventData.subarray(8, 16);
                const eventMxeProgramId = eventData.subarray(16, 48);

                if (eventOffsetBytes.equals(offsetBytes) &&
                    eventMxeProgramId.equals(mxeProgramIdBytes)) {
                  return sigInfo.signature;
                }
              }
            } catch (error) {
              continue;
            }
          }
        }
      }

      await setTimeout(pollInterval);
    } catch (error) {
      console.log(`Polling attempt ${attempt + 1} failed:`, error);
      await setTimeout(pollInterval);
    }
  }

  throw new Error(
    `Computation finalization timed out after ${maxAttempts} attempts for offset ${computationOffset}`
  );
};

/**
 * Builds a finalize computation definition instruction for the Arcium program.
 * Re-implementation of @arcium-hq/client's buildFinalizeCompDefTx without Anchor.
 *
 * This function creates a Solana Kit instruction for the finalize_computation_definition
 * instruction from the Arcium IDL. The instruction structure from IDL (0.6.3):
 * - Discriminator: [174, 66, 159, 51, 199, 243, 219, 38]
 * - Args: comp_offset (u32), mxe_program (pubkey)
 * - Accounts: signer (writable, signer), comp_def_acc (writable, PDA), comp_def_raw (PDA)
 *
 * Breaking change in 0.6.3: Added comp_def_raw as third account (PDA at index 0)
 *
 * @param connection - The Kite connection
 * @param signer - The signer KeyPairSigner
 * @param compDefOffset - The computation definition offset (u32)
 * @param mxeProgramId - The MXE program ID as an Address
 * @returns A Solana Kit Instruction
 */
export const buildFinalizeCompDefInstruction = async (
  connection: Connection,
  signer: KeyPairSigner,
  compDefOffset: number,
  mxeProgramId: Address
): Promise<Instruction> => {
  const discriminator = new Uint8Array([174, 66, 159, 51, 199, 243, 219, 38]);

  const offsetBytes = new Uint8Array(4);
  new DataView(offsetBytes.buffer).setUint32(0, compDefOffset, true);

  const mxeProgramBytes = bs58.decode(mxeProgramId);

  const instructionData = new Uint8Array(
    discriminator.length + offsetBytes.length + mxeProgramBytes.length
  );
  instructionData.set(discriminator, 0);
  instructionData.set(offsetBytes, discriminator.length);
  instructionData.set(mxeProgramBytes, discriminator.length + offsetBytes.length);

  const compDefAcc = await getComputationDefinitionAccountAddress(
    connection,
    mxeProgramId,
    new Uint8Array(offsetBytes)
  );

  const compDefRaw = await getComputationDefinitionRawAddress(connection, compDefAcc, 0);

  return {
    programAddress: ARCIUM_PROGRAM_ID,
    data: instructionData,
    accounts: [
      { address: signer.address, role: AccountRole.WRITABLE_SIGNER },
      { address: compDefAcc, role: AccountRole.WRITABLE },
      { address: compDefRaw, role: AccountRole.READONLY },
    ],
  };
};

/**
 * Derives the computation definition raw circuit account address.
 * PDA seeds: ["ComputationDefinitionRaw", comp_def_acc, raw_circuit_index]
 *
 * @param connection - The Kite connection
 * @param compDefAcc - The computation definition account address
 * @param rawCircuitIndex - The raw circuit index (u8)
 * @returns Promise resolving to the derived comp_def_raw account address
 */
export const getComputationDefinitionRawAddress = async (
  connection: Connection,
  compDefAcc: Address,
  rawCircuitIndex: number
): Promise<Address> => {
  const indexBytes = new Uint8Array(1);
  indexBytes[0] = rawCircuitIndex;

  return getArciumPDA(connection, [COMPUTATION_DEFINITION_RAW_SEED, compDefAcc, indexBytes]);
};
