import { type Address, type KeyPairSigner, type Instruction, AccountRole, address } from "@solana/kit";
import { type Connection } from "solana-kite";
import bs58 from "bs58";
import {
  getComputationDefinitionAccountAddress,
  getComputationDefinitionAccountOffset,
  getComputationDefinitionRawAddress,
  buildFinalizeCompDefInstruction,
  MAX_UPLOAD_PER_TX_BYTES,
  MAX_REALLOC_PER_IX,
  MAX_ACCOUNT_SIZE,
  MAX_EMBIGGEN_IX_PER_TX,
} from "./helpers.js";
import { ARCIUM_PROGRAM_ID } from "./constants.js";

/**
 * Upload circuit implementation using Solana Kit.
 * Re-implementation of @arcium-hq/client's uploadCircuit without Anchor/web3.js.
 */

const SYSTEM_PROGRAM_ID = address("11111111111111111111111111111111");

/**
 * Builds an init_raw_circuit_acc instruction.
 * Discriminator from Arcium IDL: [16, 228, 193, 228, 93, 231, 58, 4]
 *
 * @param connection - The connection object
 * @param signer - The signer KeyPairSigner
 * @param compDefOffset - The computation definition offset (u32)
 * @param mxeProgramId - The MXE program ID as an Address
 * @param rawCircuitIndex - The raw circuit index (u8)
 * @returns A Solana Kit Instruction
 */
export const buildInitRawCircuitAccInstruction = async (
  connection: Connection,
  signer: KeyPairSigner,
  compDefOffset: number,
  mxeProgramId: Address,
  rawCircuitIndex: number
): Promise<Instruction> => {
  // Instruction discriminator from Arcium IDL
  const discriminator = new Uint8Array([16, 228, 193, 228, 93, 231, 58, 4]);

  // Encode comp_offset as u32 (4 bytes, little-endian)
  const offsetBytes = new Uint8Array(4);
  new DataView(offsetBytes.buffer).setUint32(0, compDefOffset, true);

  // Encode mxe_program as pubkey (32 bytes)
  const mxeProgramBytes = bs58.decode(mxeProgramId);

  // Encode raw_circuit_index as u8 (1 byte)
  const indexBytes = new Uint8Array(1);
  indexBytes[0] = rawCircuitIndex;

  // Concatenate all parts into instruction data
  const instructionData = new Uint8Array(
    discriminator.length + offsetBytes.length + mxeProgramBytes.length + indexBytes.length
  );
  instructionData.set(discriminator, 0);
  instructionData.set(offsetBytes, discriminator.length);
  instructionData.set(mxeProgramBytes, discriminator.length + offsetBytes.length);
  instructionData.set(indexBytes, discriminator.length + offsetBytes.length + mxeProgramBytes.length);

  // Derive PDAs
  const compDefAcc = await getComputationDefinitionAccountAddress(connection, mxeProgramId, new Uint8Array(offsetBytes));
  const compDefRaw = await getComputationDefinitionRawAddress(connection, compDefAcc, rawCircuitIndex);

  // Return Solana Kit Instruction
  return {
    programAddress: ARCIUM_PROGRAM_ID,
    data: instructionData,
    accounts: [
      { address: signer.address, role: AccountRole.WRITABLE_SIGNER },
      { address: compDefAcc, role: AccountRole.READONLY },
      { address: compDefRaw, role: AccountRole.WRITABLE },
      { address: SYSTEM_PROGRAM_ID, role: AccountRole.READONLY },
    ],
  };
};

/**
 * Builds an embiggen_raw_circuit_acc instruction.
 * Discriminator from Arcium IDL: [92, 195, 192, 21, 193, 242, 135, 194]
 *
 * @param signer - The signer KeyPairSigner
 * @param compDefOffset - The computation definition offset (u32)
 * @param mxeProgramId - The MXE program ID as an Address
 * @param rawCircuitIndex - The raw circuit index (u8)
 * @returns A Solana Kit Instruction
 */
export const buildEmbiggenRawCircuitAccInstruction = async (
  connection: Connection,
  signer: KeyPairSigner,
  compDefOffset: number,
  mxeProgramId: Address,
  rawCircuitIndex: number
): Promise<Instruction> => {
  // Instruction discriminator from Arcium IDL
  const discriminator = new Uint8Array([92, 195, 192, 21, 193, 242, 135, 194]);

  // Encode comp_offset as u32 (4 bytes, little-endian)
  const offsetBytes = new Uint8Array(4);
  new DataView(offsetBytes.buffer).setUint32(0, compDefOffset, true);

  // Encode mxe_program as pubkey (32 bytes)
  const mxeProgramBytes = bs58.decode(mxeProgramId);

  // Encode raw_circuit_index as u8 (1 byte)
  const indexBytes = new Uint8Array(1);
  indexBytes[0] = rawCircuitIndex;

  // Concatenate all parts into instruction data
  const instructionData = new Uint8Array(
    discriminator.length + offsetBytes.length + mxeProgramBytes.length + indexBytes.length
  );
  instructionData.set(discriminator, 0);
  instructionData.set(offsetBytes, discriminator.length);
  instructionData.set(mxeProgramBytes, discriminator.length + offsetBytes.length);
  instructionData.set(indexBytes, discriminator.length + offsetBytes.length + mxeProgramBytes.length);

  // Derive PDAs
  const compDefAcc = await getComputationDefinitionAccountAddress(connection, mxeProgramId, new Uint8Array(offsetBytes));
  const compDefRaw = await getComputationDefinitionRawAddress(connection, compDefAcc, rawCircuitIndex);

  // Return Solana Kit Instruction
  return {
    programAddress: ARCIUM_PROGRAM_ID,
    data: instructionData,
    accounts: [
      { address: signer.address, role: AccountRole.WRITABLE_SIGNER },
      { address: compDefAcc, role: AccountRole.READONLY },
      { address: compDefRaw, role: AccountRole.WRITABLE },
      { address: SYSTEM_PROGRAM_ID, role: AccountRole.READONLY },
    ],
  };
};

/**
 * Builds an upload_circuit instruction.
 * Discriminator from Arcium IDL: [86, 238, 214, 111, 30, 23, 168, 100]
 *
 * @param signer - The signer KeyPairSigner
 * @param compDefOffset - The computation definition offset (u32)
 * @param mxeProgramId - The MXE program ID as an Address
 * @param rawCircuitIndex - The raw circuit index (u8)
 * @param uploadData - The data to upload (will be padded to 814 bytes)
 * @param offset - The offset in the circuit data (u32)
 * @returns A Solana Kit Instruction
 */
export const buildUploadCircuitInstruction = async (
  connection: Connection,
  signer: KeyPairSigner,
  compDefOffset: number,
  mxeProgramId: Address,
  rawCircuitIndex: number,
  uploadData: Uint8Array,
  offset: number
): Promise<Instruction> => {
  if (uploadData.length > MAX_UPLOAD_PER_TX_BYTES) {
    throw new Error(`Upload data must be ${MAX_UPLOAD_PER_TX_BYTES} bytes or less per tx`);
  }

  // Pad upload data to exactly 814 bytes
  const paddedData = new Uint8Array(MAX_UPLOAD_PER_TX_BYTES);
  paddedData.set(uploadData);

  // Instruction discriminator from Arcium IDL
  const discriminator = new Uint8Array([86, 238, 214, 111, 30, 23, 168, 100]);

  // Encode comp_offset as u32 (4 bytes, little-endian)
  const compOffsetBytes = new Uint8Array(4);
  new DataView(compOffsetBytes.buffer).setUint32(0, compDefOffset, true);

  // Encode mxe_program as pubkey (32 bytes)
  const mxeProgramBytes = bs58.decode(mxeProgramId);

  // Encode raw_circuit_index as u8 (1 byte)
  const indexBytes = new Uint8Array(1);
  indexBytes[0] = rawCircuitIndex;

  // Encode offset as u32 (4 bytes, little-endian)
  const offsetBytes = new Uint8Array(4);
  new DataView(offsetBytes.buffer).setUint32(0, offset, true);

  // Concatenate all parts into instruction data
  const instructionData = new Uint8Array(
    discriminator.length +
      compOffsetBytes.length +
      mxeProgramBytes.length +
      indexBytes.length +
      paddedData.length +
      offsetBytes.length
  );
  let pos = 0;
  instructionData.set(discriminator, pos);
  pos += discriminator.length;
  instructionData.set(compOffsetBytes, pos);
  pos += compOffsetBytes.length;
  instructionData.set(mxeProgramBytes, pos);
  pos += mxeProgramBytes.length;
  instructionData.set(indexBytes, pos);
  pos += indexBytes.length;
  instructionData.set(paddedData, pos);
  pos += paddedData.length;
  instructionData.set(offsetBytes, pos);

  // Derive PDAs
  const compDefAcc = await getComputationDefinitionAccountAddress(connection, mxeProgramId, new Uint8Array(compOffsetBytes));
  const compDefRaw = await getComputationDefinitionRawAddress(connection, compDefAcc, rawCircuitIndex);

  // Return Solana Kit Instruction
  return {
    programAddress: ARCIUM_PROGRAM_ID,
    data: instructionData,
    accounts: [
      { address: signer.address, role: AccountRole.WRITABLE_SIGNER },
      { address: compDefAcc, role: AccountRole.READONLY },
      { address: compDefRaw, role: AccountRole.WRITABLE },
      { address: SYSTEM_PROGRAM_ID, role: AccountRole.READONLY },
    ],
  };
};

/**
 * Uploads one part of a raw circuit to its account.
 * This handles init, embiggen (resize), and upload for a single circuit part.
 *
 * @param connection - Solana Kite connection
 * @param signer - The signer KeyPairSigner
 * @param rawCircuitPart - The circuit data for this part
 * @param rawCircuitIndex - The index of this circuit part
 * @param compDefOffset - The computation definition offset
 * @param mxeProgramId - The MXE program ID
 * @param logging - Whether to log progress
 * @param chunkSize - Number of upload transactions to send in parallel
 * @returns Array of transaction signatures
 */
const uploadToCircuitAcc = async (
  connection: Connection,
  signer: KeyPairSigner,
  rawCircuitPart: Uint8Array,
  rawCircuitIndex: number,
  compDefOffset: number,
  mxeProgramId: Address,
  logging: boolean,
  chunkSize: number
): Promise<Array<string>> => {
  const sigs: Array<string> = [];

  // Step 1: Initialize the raw circuit account
  const initInstruction = await buildInitRawCircuitAccInstruction(
    connection,
    signer,
    compDefOffset,
    mxeProgramId,
    rawCircuitIndex
  );

  const initSig = await connection.sendTransactionFromInstructions({
    feePayer: signer,
    instructions: [initInstruction],
    skipPreflight: true,
  });
  sigs.push(initSig);

  if (logging) {
    console.log(`Initiated raw circuit acc with raw circuit index ${rawCircuitIndex}`);
  }

  // Step 2: Resize account if needed (must be sequential)
  if (rawCircuitPart.length > MAX_REALLOC_PER_IX) {
    const resizeTxCount = Math.ceil(
      rawCircuitPart.length / (MAX_REALLOC_PER_IX * MAX_EMBIGGEN_IX_PER_TX)
    );

    for (let i = 0; i < resizeTxCount; i++) {
      if (logging) {
        console.log(`Sending resize tx ${i + 1} of ${resizeTxCount}`);
      }

      // Calculate how many embiggen instructions needed for this tx
      const currentSize = MAX_REALLOC_PER_IX + i * (MAX_REALLOC_PER_IX * MAX_EMBIGGEN_IX_PER_TX);
      const resizeSize = Math.min(
        rawCircuitPart.length - currentSize,
        MAX_EMBIGGEN_IX_PER_TX * MAX_REALLOC_PER_IX
      );
      const ixCount = Math.ceil(resizeSize / MAX_REALLOC_PER_IX);

      // Build multiple embiggen instructions for this transaction
      const embiggenInstructions: Array<Instruction> = [];
      for (let j = 0; j < ixCount; j++) {
        const embiggenInstruction = await buildEmbiggenRawCircuitAccInstruction(
          connection,
          signer,
          compDefOffset,
          mxeProgramId,
          rawCircuitIndex
        );
        embiggenInstructions.push(embiggenInstruction);
      }

      const resizeSig = await connection.sendTransactionFromInstructions({
        feePayer: signer,
        instructions: embiggenInstructions,
        skipPreflight: true,
      });
      sigs.push(resizeSig);

      if (logging) {
        console.log(`Sent resize tx ${i + 1} of ${resizeTxCount}`);
      }
    }
  }

  if (logging) {
    console.log("Done sending resize txs");
  }

  // Step 3: Upload circuit data in chunks (can be parallel within chunks)
  const uploadTxCount = Math.ceil(rawCircuitPart.length / MAX_UPLOAD_PER_TX_BYTES);

  if (logging) {
    console.log(`Sending ${uploadTxCount} upload txs`);
  }

  for (let i = 0; i < uploadTxCount; i += chunkSize) {
    if (logging) {
      console.log(
        `Sending chunk ${Math.floor(i / chunkSize) + 1} of ${Math.ceil(uploadTxCount / chunkSize)}`
      );
    }

    const currentChunkSize = Math.min(chunkSize, uploadTxCount - i);
    const uploadPromises: Array<Promise<string>> = [];

    for (let j = 0; j < currentChunkSize; j++) {
      const circuitOffset = MAX_UPLOAD_PER_TX_BYTES * (i + j);
      const uploadData = rawCircuitPart.subarray(
        circuitOffset,
        Math.min(circuitOffset + MAX_UPLOAD_PER_TX_BYTES, rawCircuitPart.length)
      );

      const uploadPromise = (async () => {
        const uploadInstruction = await buildUploadCircuitInstruction(
          connection,
          signer,
          compDefOffset,
          mxeProgramId,
          rawCircuitIndex,
          uploadData,
          circuitOffset
        );

        return await connection.sendTransactionFromInstructions({
          feePayer: signer,
          instructions: [uploadInstruction],
          skipPreflight: true,
        });
      })();

      uploadPromises.push(uploadPromise);
    }

    const chunkSigs = await Promise.all(uploadPromises);
    sigs.push(...chunkSigs);

    if (logging) {
      console.log(
        `Done sending chunk ${Math.floor(i / chunkSize) + 1} of ${Math.ceil(uploadTxCount / chunkSize)}`
      );
    }
  }

  return sigs;
};

/**
 * Uploads a raw circuit to the Arcium network using Solana Kit.
 * Re-implementation of @arcium-hq/client's uploadCircuit without Anchor.
 *
 * @param connection - Solana Kite connection
 * @param signer - The signer KeyPairSigner
 * @param circuitName - The name of the circuit (e.g., "create_poll", "vote")
 * @param mxeProgramId - The MXE program ID
 * @param rawCircuit - The raw circuit bytecode
 * @param logging - Whether to log progress (default: true)
 * @param chunkSize - Number of upload transactions to send in parallel (default: 500)
 * @returns Array of all transaction signatures
 */
export const uploadCircuit = async (
  connection: Connection,
  signer: KeyPairSigner,
  circuitName: string,
  mxeProgramId: Address,
  rawCircuit: Uint8Array,
  logging: boolean = true,
  chunkSize: number = 500
): Promise<Array<string>> => {
  const sigs: Array<string> = [];

  // Calculate number of accounts needed
  const numAccs = Math.ceil(rawCircuit.length / (MAX_ACCOUNT_SIZE - 9));

  // Get computation definition offset from circuit name
  const compDefOffsetBytes = getComputationDefinitionAccountOffset(circuitName);
  const compDefOffset = Buffer.from(compDefOffsetBytes).readUInt32LE(0);

  if (logging) {
    console.log(`Uploading ${circuitName} circuit (${rawCircuit.length} bytes) across ${numAccs} accounts`);
  }

  // Upload each part of the circuit (can be done in parallel)
  const uploadPromises: Array<Promise<Array<string>>> = [];

  for (let i = 0; i < numAccs; i++) {
    const start = i * (MAX_ACCOUNT_SIZE - 9);
    const end = Math.min((i + 1) * (MAX_ACCOUNT_SIZE - 9), rawCircuit.length);
    const rawCircuitPart = rawCircuit.subarray(start, end);

    uploadPromises.push(
      uploadToCircuitAcc(
        connection,
        signer,
        rawCircuitPart,
        i,
        compDefOffset,
        mxeProgramId,
        logging,
        chunkSize
      )
    );
  }

  const allPartSigs = await Promise.all(uploadPromises);
  sigs.push(...allPartSigs.flat());

  // Finalize the computation definition
  if (logging) {
    console.log(`Finalizing ${circuitName} computation definition`);
  }

  const finalizeInstruction = await buildFinalizeCompDefInstruction(
    connection,
    signer,
    compDefOffset,
    mxeProgramId
  );

  const finalizeSig = await connection.sendTransactionFromInstructions({
    feePayer: signer,
    instructions: [finalizeInstruction],
    skipPreflight: true,
  });
  sigs.push(finalizeSig);

  if (logging) {
    console.log(`Uploaded ${circuitName} circuit with ${sigs.length} transactions`);
  }

  return sigs;
};
