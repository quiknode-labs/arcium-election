import { type Address, type KeyPairSigner, type Instruction, AccountRole, address } from "@solana/kit";
import { connect, type Connection } from "solana-kite";
import { createHash } from "crypto";
import bs58 from "bs58";

/**
 * Re-implementation of @arcium-hq/client functions without web3.js
 * This file contains Arcium helper functions that work with Solana Kit types
 */

// Arcium program ID from Arcium client
const ARCIUM_PROGRAM_ID = address("Bv3Fb9VjzjWGfX18QTUcVycAfeLoQ5zZN6vv2g3cTZxp");

// Seed constants from Arcium client
const COMPUTATION_ACC_SEED = "ComputationAccount";
const MEMPOOL_ACC_SEED = "Mempool";
const EXEC_POOL_ACC_SEED = "Execpool";
const MXE_ACC_ACC_SEED = "MXEAccount";
const COMP_DEF_ACC_SEED = "ComputationDefinitionAccount";
const COMP_DEF_RAW_SEED = "ComputationDefinitionRaw";

/**
 * Get Arcium environment configuration from environment variables
 */
export const getArciumEnv = () => {
  const arciumClusterPubkeyString = process.env.ARCIUM_CLUSTER_PUBKEY;

  if (!arciumClusterPubkeyString) {
    throw new Error('ARCIUM_CLUSTER_PUBKEY environment variable is not set');
  }

  return {
    arciumClusterPubkey: address(arciumClusterPubkeyString),
  };
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

// Helper function to convert number to little-endian 8-byte buffer
const numberToLE8ByteArray = (num: bigint): Uint8Array => {
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setBigUint64(0, num, true); // true for little-endian
  return new Uint8Array(buffer);
};

/**
 * Derives the computation account address for a given MXE program ID and offset.
 * @param connection - The Kite connection
 * @param mxeProgramId - The address string of the MXE program.
 * @param offset - The computation offset as a bigint.
 * @returns Promise resolving to the derived computation account address.
 */
export const getComputationAccAddress = async (
  connection: Connection,
  mxeProgramId: Address,
  offset: bigint
): Promise<Address> => {
  return getArciumPDA(connection, [
    COMPUTATION_ACC_SEED,
    mxeProgramId,
    numberToLE8ByteArray(offset),
  ]);
};

/**
 * Derives the mempool account address for a given MXE program ID.
 * @param connection - The Kite connection
 * @param mxeProgramId - The address string of the MXE program.
 * @returns Promise resolving to the derived mempool account address.
 */
export const getMempoolAccAddress = async (
  connection: Connection,
  mxeProgramId: Address
): Promise<Address> => {
  return getArciumPDA(connection, [MEMPOOL_ACC_SEED, mxeProgramId]);
};

/**
 * Derives the executing pool account address for a given MXE program ID.
 * @param connection - The Kite connection
 * @param mxeProgramId - The address string of the MXE program.
 * @returns Promise resolving to the derived executing pool account address.
 */
export const getExecutingPoolAccAddress = async (
  connection: Connection,
  mxeProgramId: Address
): Promise<Address> => {
  return getArciumPDA(connection, [EXEC_POOL_ACC_SEED, mxeProgramId]);
};

/**
 * Derives the MXE account address for a given MXE program ID.
 * @param connection - The Kite connection
 * @param mxeProgramId - The address string of the MXE program.
 * @returns Promise resolving to the derived MXE account address.
 */
export const getMXEAccAddress = async (
  connection: Connection,
  mxeProgramId: Address
): Promise<Address> => {
  return getArciumPDA(connection, [MXE_ACC_ACC_SEED, mxeProgramId]);
};

/**
 * Derives the computation definition account address for a given MXE program ID and offset.
 * @param connection - The Kite connection
 * @param mxeProgramId - The address string of the MXE program.
 * @param offset - The computation definition offset as a Uint8Array (from getCompDefAccOffset).
 * @returns Promise resolving to the derived computation definition account address.
 */
export const getCompDefAccAddress = async (
  connection: Connection,
  mxeProgramId: Address,
  offset: Uint8Array
): Promise<Address> => {
  return getArciumPDA(connection, [COMP_DEF_ACC_SEED, mxeProgramId, offset]);
};

/**
 * Returns the Arcium program address.
 * @returns The Arcium program address.
 */
export const getArciumProgAddress = (): Address => {
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
 * Re-implementation of @arcium-hq/client's getCompDefAccOffset without dependencies.
 *
 * This function computes a deterministic offset by hashing the circuit name with SHA256
 * and taking the first 4 bytes. This offset is used as a seed for deriving the
 * computation definition account PDA.
 *
 * @param circuitName - The name of the circuit (e.g., "create_poll", "vote", "reveal_result")
 * @returns The first 4 bytes of the SHA256 hash as a Uint8Array
 */
export const getCompDefAccOffset = (circuitName: string): Uint8Array => {
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

  // Convert computation offset to u64 bytes (8 bytes, little-endian) for matching
  const offsetBytes = Buffer.from(serializeLE(computationOffset, 8));

  // Convert mxe program ID to bytes for matching using base58
  // Solana addresses are base58 encoded 32-byte public keys
  const mxeProgramIdBytes = Buffer.from(bs58.decode(mxeProgramId));

  // Poll for signatures until we find the finalization event
  // 1 second between polls
  const pollInterval = 1000;
  // 2 minutes timeout
  const maxAttempts = 120;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      // Get recent signatures for the Arcium program
      const signatures = await connection.rpc.getSignaturesForAddress(
        ARCIUM_PROGRAM_ID,
        { limit: 10, commitment }
      ).send();

      // Check each signature for our finalization event
      for (const sigInfo of signatures) {
        const tx = await connection.rpc.getTransaction(sigInfo.signature, {
          commitment,
          maxSupportedTransactionVersion: 0,
        }).send();

        if (!tx) continue;

        // Check transaction logs for the FinalizeComputationEvent
        const logs = tx.meta?.logMessages || [];

        for (const log of logs) {
          // Anchor events are emitted as "Program data: <base64>"
          if (log.includes('Program data:')) {
            const base64Data = log.split('Program data: ')[1];
            if (!base64Data) continue;

            try {
              const eventData = Buffer.from(base64Data, 'base64');

              // Check for FinalizeComputationEvent discriminator
              // Discriminator: [27, 75, 117, 221, 191, 213, 253, 249]
              if (eventData.length >= 8 + 8 + 32 &&
                  eventData[0] === 27 &&
                  eventData[1] === 75 &&
                  eventData[2] === 117 &&
                  eventData[3] === 221 &&
                  eventData[4] === 191 &&
                  eventData[5] === 213 &&
                  eventData[6] === 253 &&
                  eventData[7] === 249) {

                // Extract computation_offset (u64) and mxe_program_id (pubkey)
                const eventOffsetBytes = eventData.subarray(8, 16);
                const eventMxeProgramId = eventData.subarray(16, 48);

                // Check if this event matches our computation
                if (eventOffsetBytes.equals(offsetBytes) &&
                    eventMxeProgramId.equals(mxeProgramIdBytes)) {
                  return sigInfo.signature;
                }
              }
            } catch (error) {
              // Skip invalid base64 or malformed events
              continue;
            }
          }
        }
      }

      // Wait before polling again
      await new Promise(resolve => setTimeout(resolve, pollInterval));
    } catch (error) {
      console.log(`Polling attempt ${attempt + 1} failed:`, error);
      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }
  }

  throw new Error(
    `Computation finalization timed out after ${maxAttempts} attempts for offset ${computationOffset}`
  );
};

/**
 * Deserializes a little-endian byte array to a BigInt.
 * Re-implementation of @arcium-hq/client's deserializeLE without dependencies.
 *
 * This function converts a byte array in little-endian format to a BigInt by
 * treating each byte as an 8-bit value and shifting it to its proper position.
 *
 * @param bytes - The byte array to deserialize (Uint8Array or Buffer)
 * @returns The deserialized value as a BigInt
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
 * Builds a finalize computation definition instruction for the Arcium program.
 * Re-implementation of @arcium-hq/client's buildFinalizeCompDefTx without Anchor.
 *
 * This function creates a Solana Kit instruction for the finalize_computation_definition
 * instruction from the Arcium IDL. The instruction structure from IDL:
 * - Discriminator: [174, 66, 159, 51, 199, 243, 219, 38]
 * - Args: comp_offset (u32), mxe_program (pubkey)
 * - Accounts: signer (writable, signer), comp_def_acc (writable, PDA)
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
  // Instruction discriminator from Arcium IDL
  const discriminator = new Uint8Array([174, 66, 159, 51, 199, 243, 219, 38]);

  // Encode comp_offset as u32 (4 bytes, little-endian)
  const offsetBytes = new Uint8Array(4);
  new DataView(offsetBytes.buffer).setUint32(0, compDefOffset, true);

  // Encode mxe_program as pubkey (32 bytes)
  const mxeProgramBytes = bs58.decode(mxeProgramId);

  // Concatenate all parts into instruction data
  const instructionData = new Uint8Array(
    discriminator.length + offsetBytes.length + mxeProgramBytes.length
  );
  instructionData.set(discriminator, 0);
  instructionData.set(offsetBytes, discriminator.length);
  instructionData.set(mxeProgramBytes, discriminator.length + offsetBytes.length);

  // Derive the comp_def_acc PDA
  const compDefAcc = await getCompDefAccAddress(
    connection,
    mxeProgramId,
    new Uint8Array(offsetBytes)
  );

  // Return Solana Kit Instruction
  return {
    programAddress: ARCIUM_PROGRAM_ID,
    data: instructionData,
    accounts: [
      { address: signer.address, role: AccountRole.WRITABLE_SIGNER },
      { address: compDefAcc, role: AccountRole.WRITABLE },
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
export const getCompDefRawAddress = async (
  connection: Connection,
  compDefAcc: Address,
  rawCircuitIndex: number
): Promise<Address> => {
  // Convert raw_circuit_index to u8 (1 byte)
  const indexBytes = new Uint8Array(1);
  indexBytes[0] = rawCircuitIndex;

  return getArciumPDA(connection, [COMP_DEF_RAW_SEED, compDefAcc, indexBytes]);
};
