import { getMXEPublicKey, x25519 } from "@arcium-hq/client";
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { setTimeout } from "timers/promises";
import { randomBytes } from "crypto";

export const getMXEPublicKeyWithRetry = async (
  provider: anchor.AnchorProvider,
  programId: PublicKey,
  maxRetries: number = 10,
  retryDelayMs: number = 500
): Promise<Uint8Array> => {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const mxePublicKey = await getMXEPublicKey(provider, programId);
      if (mxePublicKey) {
        return mxePublicKey;
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
 * @param provider - The Anchor provider to interact with the Solana network
 * @param programId - The program ID to fetch the MXE public key from
 * @returns An object containing the private key, public key, and shared secret needed for encryption
 */
export const makeClientSideKeys = async (provider: anchor.AnchorProvider, programId: PublicKey) => {

  const mxePublicKey = await getMXEPublicKeyWithRetry(
    provider,
    programId
  );

  const privateKey = x25519.utils.randomSecretKey();
  const publicKey = x25519.getPublicKey(privateKey);
  const sharedSecret = x25519.getSharedSecret(privateKey, mxePublicKey);

  return { privateKey, publicKey, sharedSecret };
}

export const getRandomBigNumber = () => {
  return new anchor.BN(randomBytes(8), "hex")
}

/**
 * Waits for a program event to be emitted and properly cleans up the event listener.
 * 
 * This helper exists because Anchor's event listeners must be manually removed to prevent
 * memory leaks. Without proper cleanup, listeners accumulate over time, causing performance
 * degradation and potential out-of-memory errors in long-running test suites. Additionally,
 * this function provides type-safe event handling by ensuring the returned event matches
 * the expected event name from the program's IDL.
 * 
 * @param program - The Anchor program instance to listen for events on
 * @param eventName - The name of the event to wait for (must be a valid event name from the program's IDL)
 * @returns A promise that resolves to the emitted event data, with proper type inference
 */
export const awaitEvent = async <
  Idl extends anchor.Idl,
  EventName extends keyof anchor.IdlEvents<Idl>
>(
  program: Program<Idl>,
  eventName: EventName
): Promise<anchor.IdlEvents<Idl>[EventName]> => {
  let listenerId: number;
  const event = await new Promise<anchor.IdlEvents<Idl>[EventName]>((resolve) => {
    listenerId = program.addEventListener(eventName, (event) => {
      resolve(event);
    });
  });
  await program.removeEventListener(listenerId);

  return event;
};