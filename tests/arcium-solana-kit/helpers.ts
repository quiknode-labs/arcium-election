import { x25519 } from "@noble/curves/ed25519";
import { type Address } from "@solana/kit";
import { connect } from "solana-kite";
import { getMXEAccAddress, deserializeLE } from "./arcium-kit-helpers.js";
import { setTimeout } from "timers/promises";
import { randomBytes } from "crypto";

/**
 * Fetches the MXE public key with retry logic using Solana Kit.
 * Re-implementation of @arcium-hq/client's getMXEPublicKey without web3.js.
 *
 * Parses the MXEAccount based on Arcium IDL structure:
 * - authority: Option<Pubkey> (33 bytes: 1 byte option + 32 bytes pubkey)
 * - cluster: Option<u32> (5 bytes: 1 byte option + 4 bytes u32)
 * - utility_pubkeys: SetUnset<UtilityPubkeys> enum
 *   - Set(UtilityPubkeys): variant 1 + UtilityPubkeys (160 bytes)
 *   - Unset(UtilityPubkeys, Vec<bool>): variant 0 + UtilityPubkeys (160 bytes) + Vec<bool>
 * - UtilityPubkeys struct (160 bytes total):
 *   - x25519_pubkey: [u8; 32]
 *   - ed25519_verifying_key: [u8; 32]
 *   - elgamal_pubkey: [u8; 32]
 *   - pubkey_validity_proof: [u8; 64]
 *
 * @param programId - The MXE program ID as an Address
 * @param maxRetries - Maximum number of retry attempts
 * @param retryDelayMs - Delay between retries in milliseconds
 * @returns The MXE's x25519 public key as a Uint8Array
 */
export const getMXEPublicKeyWithRetry = async (
  programId: Address,
  maxRetries: number = 10,
  retryDelayMs: number = 500
): Promise<Uint8Array> => {
  const connection = connect("localnet");
  const mxeAccAddress = await getMXEAccAddress(connection, programId);

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const accountInfo = await connection.rpc.getAccountInfo(mxeAccAddress, {
        encoding: "base64",
      }).send();

      if (!accountInfo.value) {
        throw new Error(`MXE account not found at ${mxeAccAddress}`);
      }

      const accountData = Buffer.from(accountInfo.value.data[0], "base64");

      // Parse MXEAccount structure from Arcium IDL
      // Skip discriminator (8 bytes)
      let offset = 8;

      // Skip authority: Option<Pubkey> (1 + 32 bytes)
      offset += 33;

      // Skip cluster: Option<u32> (1 + 4 bytes)
      offset += 5;

      // Parse utility_pubkeys: SetUnset<UtilityPubkeys>
      const utilityPubkeysVariant = accountData.readUInt8(offset);
      offset += 1;

      // Extract x25519_pubkey from UtilityPubkeys (first 32 bytes of the struct)
      const x25519Pubkey = accountData.subarray(offset, offset + 32);

      // Check variant type
      if (utilityPubkeysVariant === 1) {
        // Set variant: key is available
        return new Uint8Array(x25519Pubkey);
      } else if (utilityPubkeysVariant === 0) {
        // Unset variant: check if all booleans in Vec<bool> are true
        // UtilityPubkeys is 160 bytes total
        const utilityPubkeysSize = 160;
        const vecBoolOffset = offset + utilityPubkeysSize;

        // Vec<bool> starts with u32 length
        const vecLength = accountData.readUInt32LE(vecBoolOffset);
        const boolsOffset = vecBoolOffset + 4;

        // Check if all bools are true (non-zero)
        const allTrue = accountData
          .subarray(boolsOffset, boolsOffset + vecLength)
          .every((byte) => byte !== 0);

        if (allTrue) {
          return new Uint8Array(x25519Pubkey);
        }
      }

      throw new Error("MXE public key not set in account");
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
}

/**
 * Generates client-side encryption keys for Arcium confidential computing.
 *
 * This helper exists because Arcium requires each user to establish a shared secret with the
 * MXE (Multi-Party Execution Environment) before they can encrypt/decrypt confidential data.
 * The process involves: (1) fetching the MXE's public key from the onchain program,
 * (2) generating a client-side x25519 key pair, and (3) computing a shared secret using
 * Diffie-Hellman key exchange. The shared secret is then used with RescueCipher to encrypt
 * votes before sending them to the program, ensuring votes remain confidential throughout
 * the voting process.
 *
 * This function centralizes this multi-step setup process and is reusable across multiple
 * test users, avoiding code duplication and ensuring consistent key generation.
 *
 * @param programId - The MXE program ID as an Address
 * @returns An object containing the private key, public key, and shared secret needed for encryption
 */
export const makeClientSideKeys = async (programId: Address) => {
  const mxePublicKey = await getMXEPublicKeyWithRetry(programId);

  const privateKey = x25519.utils.randomSecretKey();
  const publicKey = x25519.getPublicKey(privateKey);
  const sharedSecret = x25519.getSharedSecret(privateKey, mxePublicKey);

  return { privateKey, publicKey, sharedSecret };
}

/**
 * Generates a random bigint from 8 random bytes.
 * Re-implementation without bn.js dependency.
 *
 * @returns A random bigint value
 */
export const getRandomBigInt = (): bigint => {
  const bytes = randomBytes(8);
  return deserializeLE(bytes);
}