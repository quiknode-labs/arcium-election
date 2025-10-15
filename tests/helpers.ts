import { getMXEPublicKey, x25519 } from "@arcium-hq/client";
import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { setTimeout } from "timers/promises";
import { randomBytes } from "crypto";

export const getMXEPublicKeyWithRetry = async function (
  provider: anchor.AnchorProvider,
  programId: PublicKey,
  maxRetries: number = 10,
  retryDelayMs: number = 500
): Promise<Uint8Array> {
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

export const makeClientSideKeys = async function (provider: anchor.AnchorProvider, programId: PublicKey) {

  const mxePublicKey = await getMXEPublicKeyWithRetry(
    provider,
    programId
  );

  console.log("MXE x25519 pubkey is", mxePublicKey);

  const privateKey = x25519.utils.randomSecretKey();
  const publicKey = x25519.getPublicKey(privateKey);
  const sharedSecret = x25519.getSharedSecret(privateKey, mxePublicKey);

  return { privateKey, publicKey, sharedSecret };
}

export const getRandomBigNumber = () => {
  return new anchor.BN(randomBytes(8), "hex")
}