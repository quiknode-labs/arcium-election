import { type KeyPairSigner, createKeyPairSignerFromBytes } from "@solana/kit";
import * as fs from "fs/promises";

/**
 * Load a wallet from file as a KeyPairSigner.
 * Reads a JSON file containing a secret key array and creates a Solana Kit KeyPairSigner.
 */
export const loadWalletFromFileWithSecretKey = async (filepath: string): Promise<KeyPairSigner> => {
  const fileContents = await fs.readFile(filepath, 'utf-8');
  const secretKeyArray = Uint8Array.from(JSON.parse(fileContents));
  const signer = await createKeyPairSignerFromBytes(secretKeyArray);
  return signer;
};
