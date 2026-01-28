import { type Address } from "@solana/kit";
import { connect } from "solana-kite";
import bs58 from "bs58";
import { serializeLE } from "./helpers.js";
import { ARCIUM_PROGRAM_ID } from "./constants.js";

/**
 * Listens for Arcium FinalizeComputationEvent using WebSocket subscriptions.
 * More efficient than polling - receives events in real-time via connection.rpcSubscriptions.
 *
 * The pattern:
 * 1. Call logsNotifications() to get a PendingRpcSubscriptionsRequest
 * 2. Call .subscribe() with AbortSignal to get Promise<AsyncIterable>
 * 3. Use for await...of to consume notifications
 *
 * @param computationOffset - The computation offset to watch for
 * @param mxeProgramId - The MXE program ID
 * @param commitment - Commitment level
 * @returns Promise resolving to the transaction signature when the event is detected
 */
export const awaitComputationFinalizationSubscription = async (
  computationOffset: bigint,
  mxeProgramId: Address,
  commitment: "processed" | "confirmed" | "finalized" = "confirmed"
): Promise<string> => {
  const connection = connect("localnet");

  const FINALIZE_EVENT_DISCRIMINATOR = new Uint8Array([27, 75, 117, 221, 191, 213, 253, 249]);

  const offsetBytes = Buffer.from(serializeLE(computationOffset, 8));
  const mxeProgramIdBytes = Buffer.from(bs58.decode(mxeProgramId));

  return new Promise((resolve, reject) => {
    const abortController = new AbortController();

    const timeoutHandle = setTimeout(() => {
      abortController.abort();
      reject(new Error(`Computation finalization timed out after 120 seconds for offset ${computationOffset}`));
    }, 120_000);

    const subscribeToLogs = async () => {
      try {
        const logsAsyncIterable = await connection.rpcSubscriptions
          .logsNotifications(
            { mentions: [ARCIUM_PROGRAM_ID] },
            { commitment }
          )
          .subscribe({ abortSignal: abortController.signal });

        for await (const notification of logsAsyncIterable) {
          const { value } = notification;

          if (value.err) continue;

          for (const log of value.logs) {
            if (log.includes('Program data:')) {
              const base64Data = log.split('Program data: ')[1];
              if (!base64Data) continue;

              try {
                const eventData = Buffer.from(base64Data, 'base64');

                if (eventData.length >= 8 + 8 + 32 &&
                    eventData.subarray(0, 8).equals(FINALIZE_EVENT_DISCRIMINATOR)) {

                  const eventOffsetBytes = eventData.subarray(8, 16);
                  const eventMxeProgramId = eventData.subarray(16, 48);

                  if (eventOffsetBytes.equals(offsetBytes) &&
                      eventMxeProgramId.equals(mxeProgramIdBytes)) {
                    clearTimeout(timeoutHandle);
                    abortController.abort();
                    resolve(value.signature);
                    return;
                  }
                }
              } catch (error) {
                continue;
              }
            }
          }
        }
      } catch (error) {
        clearTimeout(timeoutHandle);
        if ((error as Error)?.name !== 'AbortError') {
          reject(error);
        }
      }
    };

    subscribeToLogs();
  });
};

/**
 * Parses Anchor events from transaction logs.
 * Anchor events are emitted as "Program data: <base64>" in logs.
 *
 * @param logs - Array of log messages from a transaction
 * @param eventDiscriminator - 8-byte discriminator for the event type
 * @returns Parsed event data or null if not found
 */
export const parseAnchorEventFromLogs = (
  logs: ReadonlyArray<string>,
  eventDiscriminator: Uint8Array
): Buffer | null => {
  for (const log of logs) {
    if (log.includes('Program data:')) {
      const base64Data = log.split('Program data: ')[1];
      if (!base64Data) continue;

      try {
        const eventData = Buffer.from(base64Data, 'base64');

        // Check if discriminator matches
        if (eventData.length >= 8 &&
            eventData.subarray(0, 8).equals(Buffer.from(eventDiscriminator))) {
          return eventData;
        }
      } catch (error) {
        continue;
      }
    }
  }

  return null;
};

/**
 * Parses RevealResultEvent from transaction.
 * Event structure: [discriminator: 8 bytes][output: u8]
 *
 * @param signature - Transaction signature to fetch
 * @param commitment - Commitment level
 * @returns The winning option (0-2) or null if event not found
 */
export const getRevealResultFromTransaction = async (
  signature: string,
  commitment: "processed" | "confirmed" | "finalized" = "confirmed"
): Promise<number | null> => {
  const connection = connect("localnet");

  const REVEAL_RESULT_EVENT_DISCRIMINATOR = new Uint8Array([20, 154, 125, 179, 190, 191, 232, 228]);

  const tx = await connection.rpc.getTransaction(signature as any, {
    commitment,
    encoding: "json",
    maxSupportedTransactionVersion: 0,
  }).send();

  if (!tx || !tx.meta?.logMessages) {
    return null;
  }

  const eventData = parseAnchorEventFromLogs(tx.meta.logMessages, REVEAL_RESULT_EVENT_DISCRIMINATOR);

  if (!eventData || eventData.length < 9) {
    return null;
  }

  const winner = eventData[8];
  return winner;
};

/**
 * Waits for and retrieves the result from a reveal_result computation.
 * After Arcium finalizes the computation, it invokes the reveal_result_callback
 * which emits the RevealResultEvent containing the winner.
 *
 * This searches Arcium program transactions since Arcium invokes the callback via CPI.
 *
 * @param commitment - Commitment level
 * @returns The winning option (0-2)
 */
export const awaitRevealResult = async (
  commitment: "processed" | "confirmed" | "finalized" = "confirmed"
): Promise<number> => {
  const connection = connect("localnet");

  const REVEAL_RESULT_EVENT_DISCRIMINATOR = new Uint8Array([20, 154, 125, 179, 190, 191, 232, 228]);

  const pollInterval = 1000;
  const maxAttempts = 120;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const signatures = await connection.rpc.getSignaturesForAddress(
        ARCIUM_PROGRAM_ID,
        { limit: 20 }
      ).send();

      if (attempt % 10 === 0) {
        console.log(`Polling attempt ${attempt + 1}/${maxAttempts}: Found ${signatures.length} recent Arcium transactions`);
      }

      for (const signatureInfo of signatures) {
        const transaction = await connection.rpc.getTransaction(signatureInfo.signature, {
          commitment,
          encoding: "json",
          maxSupportedTransactionVersion: 0,
        }).send();

        if (!transaction || !transaction.meta?.logMessages) continue;

        const eventData = parseAnchorEventFromLogs(transaction.meta.logMessages, REVEAL_RESULT_EVENT_DISCRIMINATOR);

        if (eventData && eventData.length >= 9) {
          const winner = eventData[8];
          console.log(`✅ Found RevealResultEvent! Winner: ${winner}`);
          return winner;
        }
      }

      await new Promise(resolve => setTimeout(resolve, pollInterval));
    } catch (error) {
      console.log(`Polling attempt ${attempt + 1} failed:`, error);
      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }
  }

  throw new Error(
    `Failed to find RevealResultEvent after ${maxAttempts} attempts`
  );
};
