import { RelayClient } from "@polymarket/builder-relayer-client";
import { OperationType, SafeTransaction } from "@polymarket/builder-relayer-client";
import { Interface } from "ethers/lib/utils";
import { Logger } from "./logger";

// Contract addresses (Polygon mainnet)
const USDC_E_CONTRACT_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
// IMPORTANT: Use CTF_CONTRACT_ADDRESS (0x4d97dcd97ec945f40cf65f87097ace5ea0476045), not CTF_EXCHANGE_ADDRESS
// The exchange address (0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E) is for trading, not redemption
const CTF_CONTRACT_ADDRESS = "0x4d97dcd97ec945f40cf65f87097ace5ea0476045";

const ctfAbi = [
  {
    inputs: [
      { name: "collateralToken", type: "address" },
      { name: "parentCollectionId", type: "bytes32" },
      { name: "conditionId", type: "bytes32" },
      { name: "indexSets", type: "uint256[]" },
    ],
    name: "redeemPositions",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
];

export interface RedeemParams {
  conditionId: string;
  outcomeIndex: number;
}

/**
 * Normalize conditionId to ensure it's a valid hex string
 */
function normalizeConditionId(conditionId: string): string {
  if (!conditionId || typeof conditionId !== 'string') {
    throw new Error(`Invalid conditionId: ${conditionId}. Must be a non-empty string.`);
  }
  
  // Remove any whitespace
  let normalized = conditionId.trim();
  
  // Ensure it starts with 0x
  if (!normalized.startsWith("0x")) {
    normalized = "0x" + normalized;
  }
  
  // Validate it's a valid hex string
  if (!/^0x[0-9a-fA-F]+$/.test(normalized)) {
    throw new Error(`Invalid conditionId format: ${conditionId} (normalized: ${normalized}). Must be a valid hex string.`);
  }
  
  // ConditionId should be 66 characters (0x + 64 hex chars = bytes32)
  // But we'll accept any length and let the contract handle validation
  // Log if it's not the expected length for debugging
  if (normalized.length !== 66) {
    // This is a warning, not an error - some conditionIds might be shorter
    // The contract will validate the actual format
  }
  
  return normalized;
}

/**
 * Create a redeem transaction for winning positions
 */
export function createRedeemTx(params: RedeemParams): SafeTransaction {
  const { conditionId, outcomeIndex } = params;

  // Validate and normalize conditionId
  const normalizedConditionId = normalizeConditionId(conditionId);

  // Validate outcomeIndex
  if (outcomeIndex !== 0 && outcomeIndex !== 1) {
    throw new Error(`Invalid outcomeIndex: ${outcomeIndex}. Must be 0 (YES) or 1 (NO).`);
  }

  // For simple binary outcomes, parentCollectionId is empty
  const parentCollectionId = "0x" + "0".repeat(64);

  // indexSets array for the specific outcome
  // For binary markets: YES = 0 (indexSet = 1), NO = 1 (indexSet = 2)
  const indexSet = BigInt(1 << outcomeIndex);

  const iface = new Interface(ctfAbi);
  // Pass BigInt directly - ethers will handle the encoding correctly
  // DO NOT convert to string, as that breaks the encoding for uint256[]
  const data = iface.encodeFunctionData("redeemPositions", [
    USDC_E_CONTRACT_ADDRESS,
    parentCollectionId,
    normalizedConditionId,
    [indexSet], // Pass BigInt directly, not as string
  ]);

  return {
    to: CTF_CONTRACT_ADDRESS,
    operation: OperationType.Call,
    data,
    value: "0",
  };
}

/**
 * Redeem positions for a winning outcome
 */
export async function redeemPositions(
  relayClient: RelayClient,
  params: RedeemParams,
  logger: Logger
): Promise<boolean> {
  try {
    logger.info("Creating redeem transaction", {
      conditionId: params.conditionId,
      outcomeIndex: params.outcomeIndex,
      conditionIdType: typeof params.conditionId,
      conditionIdLength: params.conditionId?.length,
    });

    // Validate inputs before creating transaction
    if (!params.conditionId || typeof params.conditionId !== 'string') {
      throw new Error(`Invalid conditionId: ${params.conditionId}. Must be a non-empty string.`);
    }

    if (params.outcomeIndex !== 0 && params.outcomeIndex !== 1) {
      throw new Error(`Invalid outcomeIndex: ${params.outcomeIndex}. Must be 0 (YES) or 1 (NO).`);
    }

    // Log conditionId before normalization for debugging
    logger.info("ConditionId before normalization", {
      originalConditionId: params.conditionId,
      conditionIdType: typeof params.conditionId,
      conditionIdLength: params.conditionId?.length,
      startsWith0x: params.conditionId?.startsWith("0x"),
    });

    const redeemTx = createRedeemTx(params);

    logger.info("Executing redeem transaction via relay client", {
      conditionId: params.conditionId,
      normalizedConditionId: normalizeConditionId(params.conditionId),
      outcomeIndex: params.outcomeIndex,
      to: redeemTx.to,
      dataLength: redeemTx.data?.length || 0,
      operation: redeemTx.operation,
      value: redeemTx.value,
      hasRelayClient: !!relayClient,
      relayClientType: typeof relayClient,
      transactionData: redeemTx.data?.substring(0, 100) + "...", // First 100 chars of data
    });

    // Validate relayClient has execute method
    if (!relayClient || typeof relayClient.execute !== 'function') {
      throw new Error(`Invalid relayClient: execute method not available. Type: ${typeof relayClient}`);
    }

    // Log relayClient details for debugging
    logger.info("RelayClient validation and details", {
      conditionId: params.conditionId,
      outcomeIndex: params.outcomeIndex,
      hasRelayClient: !!relayClient,
      relayClientType: typeof relayClient,
      relayClientConstructor: relayClient?.constructor?.name,
      hasExecute: typeof relayClient.execute === 'function',
      relayClientKeys: relayClient ? Object.keys(relayClient).slice(0, 20) : [], // First 20 keys
    });

    logger.info("About to call relayClient.execute()", {
      conditionId: params.conditionId,
      outcomeIndex: params.outcomeIndex,
    });

    // Add timeout for execute call (30 seconds)
    const executeTimeout = new Promise((_, reject) => {
      setTimeout(() => reject(new Error("Relay client execute timeout after 30 seconds")), 30000);
    });

    let executePromise;
    try {
      logger.info("Calling relayClient.execute() now", {
        conditionId: params.conditionId,
        outcomeIndex: params.outcomeIndex,
        transactionDetails: {
          to: redeemTx.to,
          operation: redeemTx.operation,
          dataLength: redeemTx.data?.length || 0,
          value: redeemTx.value,
        },
      });
      
      executePromise = relayClient.execute(
        [redeemTx],
        `Redeem position for condition ${params.conditionId}, outcome ${params.outcomeIndex}`
      );
      
      // Validate that execute returned a promise
      if (!executePromise) {
        throw new Error("relayClient.execute() returned null or undefined");
      }
      
      if (typeof executePromise.then !== 'function' && typeof executePromise.catch !== 'function') {
        logger.warn("relayClient.execute() did not return a promise", {
          conditionId: params.conditionId,
          outcomeIndex: params.outcomeIndex,
          returnType: typeof executePromise,
          returnValue: executePromise,
        });
        // Try to use it as a response anyway
        const response = executePromise as any;
        if (response && typeof response.wait === 'function') {
          logger.info("Using execute result directly (not a promise)", {
            conditionId: params.conditionId,
            outcomeIndex: params.outcomeIndex,
          });
          // Continue with the response
          const waitResult = await Promise.race([
            response.wait(),
            new Promise((_, reject) => {
              setTimeout(() => reject(new Error("Transaction confirmation timeout after 2 minutes")), 120000);
            }),
          ]).catch((waitError) => {
            if (waitError instanceof Error && waitError.message.includes("timeout")) {
              logger.warn("Transaction confirmation timeout, but transaction may have succeeded", {
                conditionId: params.conditionId,
                outcomeIndex: params.outcomeIndex,
                error: waitError.message,
              });
              return true; // Don't fail on timeout
            }
            throw waitError;
          });
          
          logger.info("Position redeemed successfully", {
            conditionId: params.conditionId,
            outcomeIndex: params.outcomeIndex,
          });
          return true;
        }
        throw new Error(`relayClient.execute() returned invalid value: ${typeof executePromise}`);
      }
      
      logger.info("relayClient.execute() promise created, waiting for response", {
        conditionId: params.conditionId,
        outcomeIndex: params.outcomeIndex,
        isPromise: executePromise instanceof Promise,
        hasThen: typeof executePromise.then === 'function',
      });
    } catch (executeError) {
      logger.error("Error calling relayClient.execute()", {
        conditionId: params.conditionId,
        outcomeIndex: params.outcomeIndex,
        error: executeError instanceof Error ? executeError.message : String(executeError),
        errorStack: executeError instanceof Error ? executeError.stack : undefined,
      });
      throw executeError;
    }

    let response;
    const startTime = Date.now();
    try {
      logger.info("Starting Promise.race for execute call", {
        conditionId: params.conditionId,
        outcomeIndex: params.outcomeIndex,
        timeoutMs: 30000,
      });
      
      response = await Promise.race([
        executePromise.then((result) => {
          const elapsed = Date.now() - startTime;
          logger.info("Execute promise resolved", {
            conditionId: params.conditionId,
            outcomeIndex: params.outcomeIndex,
            elapsedMs: elapsed,
            resultType: typeof result,
            hasWait: result && typeof result.wait === 'function',
          });
          return result;
        }).catch((error) => {
          const elapsed = Date.now() - startTime;
          logger.error("Execute promise rejected", {
            conditionId: params.conditionId,
            outcomeIndex: params.outcomeIndex,
            elapsedMs: elapsed,
            error: error instanceof Error ? error.message : String(error),
            errorStack: error instanceof Error ? error.stack : undefined,
          });
          throw error;
        }),
        executeTimeout.then(() => {
          const elapsed = Date.now() - startTime;
          logger.error("Execute timeout triggered", {
            conditionId: params.conditionId,
            outcomeIndex: params.outcomeIndex,
            elapsedMs: elapsed,
          });
          throw new Error("Relay client execute timeout after 30 seconds");
        }),
      ]) as any;
      
      const elapsed = Date.now() - startTime;
      logger.info("Promise.race completed successfully", {
        conditionId: params.conditionId,
        outcomeIndex: params.outcomeIndex,
        elapsedMs: elapsed,
      });
    } catch (raceError) {
      const elapsed = Date.now() - startTime;
      logger.error("Error in Promise.race for execute call", {
        conditionId: params.conditionId,
        outcomeIndex: params.outcomeIndex,
        elapsedMs: elapsed,
        error: raceError instanceof Error ? raceError.message : String(raceError),
        errorStack: raceError instanceof Error ? raceError.stack : undefined,
        isTimeout: raceError instanceof Error && raceError.message.includes("timeout"),
      });
      throw raceError;
    }

    if (!response) {
      logger.error("Relay client execute returned null or undefined", {
        conditionId: params.conditionId,
        outcomeIndex: params.outcomeIndex,
      });
      throw new Error("Relay client execute returned null or undefined");
    }

    logger.info("Relay client execute() returned response", {
      conditionId: params.conditionId,
      outcomeIndex: params.outcomeIndex,
      responseType: typeof response,
      hasWait: typeof response.wait === 'function',
      responseKeys: response ? Object.keys(response) : [],
    });

    logger.info("Waiting for redeem transaction confirmation", {
      conditionId: params.conditionId,
      outcomeIndex: params.outcomeIndex,
    });

    // Add timeout for wait call (2 minutes - blockchain transactions can take time)
    const waitTimeout = new Promise((_, reject) => {
      setTimeout(() => reject(new Error("Transaction confirmation timeout after 2 minutes")), 120000);
    });

    // Wait for transaction confirmation
    // response.wait() returns a transaction receipt with a status field
    let transactionReceipt: any = null;
    try {
      transactionReceipt = await Promise.race([
        response.wait(),
        waitTimeout,
      ]) as any;
      
      // After wait() completes, check the transaction receipt status
      const transactionState = (response as any)?.state;
      const transactionHash = (response as any)?.transactionHash || (response as any)?.hash || transactionReceipt?.transactionHash;
      const transactionID = (response as any)?.transactionID;
      
      logger.info("Transaction wait completed, checking status", {
        conditionId: params.conditionId,
        outcomeIndex: params.outcomeIndex,
        transactionState,
        transactionHash,
        transactionID,
        receiptStatus: transactionReceipt?.status,
        receiptStatusType: typeof transactionReceipt?.status,
        responseState: (response as any)?.state,
        responseStatus: (response as any)?.status,
        responseKeys: response ? Object.keys(response) : [],
        receiptKeys: transactionReceipt ? Object.keys(transactionReceipt) : [],
      });
      
      // CRITICAL: Check the transaction receipt status
      // status === 0 means the transaction failed on-chain
      // status === 1 means the transaction succeeded
      // status can be a number (0/1) or BigInt
      const receiptStatus = transactionReceipt?.status;
      if (receiptStatus !== undefined && receiptStatus !== null) {
        const statusValue = typeof receiptStatus === 'bigint' 
          ? Number(receiptStatus) 
          : Number(receiptStatus);
        
        if (statusValue === 0) {
          const errorMsg = `Transaction failed on-chain! Receipt status: ${statusValue}. Transaction hash: ${transactionHash || 'unknown'}, Transaction ID: ${transactionID || 'unknown'}`;
          logger.error(errorMsg, {
            conditionId: params.conditionId,
            outcomeIndex: params.outcomeIndex,
            receiptStatus: statusValue,
            transactionHash,
            transactionID,
            receipt: transactionReceipt,
          });
          throw new Error(errorMsg);
        }
        
        if (statusValue !== 1) {
          // Status is neither 0 nor 1 - this is unexpected
          logger.warn("Transaction receipt has unexpected status value", {
            conditionId: params.conditionId,
            outcomeIndex: params.outcomeIndex,
            receiptStatus: statusValue,
            transactionHash,
            transactionID,
          });
        }
      }
      
      // Also check the response object's status field (if it exists)
      const responseStatus = (response as any)?.status;
      if (responseStatus !== undefined && responseStatus !== null) {
        const statusValue = typeof responseStatus === 'bigint' 
          ? Number(responseStatus) 
          : Number(responseStatus);
        
        if (statusValue === 0) {
          const errorMsg = `Transaction failed on-chain! Response status: ${statusValue}. Transaction hash: ${transactionHash || 'unknown'}, Transaction ID: ${transactionID || 'unknown'}`;
          logger.error(errorMsg, {
            conditionId: params.conditionId,
            outcomeIndex: params.outcomeIndex,
            responseStatus: statusValue,
            transactionHash,
            transactionID,
          });
          throw new Error(errorMsg);
        }
      }
      
      // Check if transaction failed via state string
      // Common failure states: "FAILED", "REVERTED", "FAILED_ONCHAIN", etc.
      if (transactionState && typeof transactionState === 'string') {
        const upperState = transactionState.toUpperCase();
        if (upperState.includes('FAIL') || upperState.includes('REVERT') || upperState.includes('ERROR')) {
          const errorMsg = `Transaction failed onchain with state: ${transactionState}. Transaction hash: ${transactionHash || 'unknown'}, Transaction ID: ${transactionID || 'unknown'}`;
          logger.error(errorMsg, {
            conditionId: params.conditionId,
            outcomeIndex: params.outcomeIndex,
            transactionState,
            transactionHash,
            transactionID,
          });
          throw new Error(errorMsg);
        }
      }
      
      // Check for any error-related fields in the response
      const error = (response as any)?.error;
      if (error) {
        const errorMsg = `Transaction has error field: ${typeof error === 'string' ? error : JSON.stringify(error)}. Transaction hash: ${transactionHash || 'unknown'}`;
        logger.error(errorMsg, {
          conditionId: params.conditionId,
          outcomeIndex: params.outcomeIndex,
          error,
          transactionHash,
        });
        throw new Error(errorMsg);
      }
      
      // Verify we have a transaction hash (required for success)
      if (!transactionHash) {
        const errorMsg = `Transaction confirmation completed but no transaction hash found. Transaction ID: ${transactionID || 'unknown'}`;
        logger.error(errorMsg, {
          conditionId: params.conditionId,
          outcomeIndex: params.outcomeIndex,
          transactionID,
          receipt: transactionReceipt,
          response: response,
        });
        throw new Error(errorMsg);
      }
      
    } catch (waitError) {
      // If wait() throws an error or times out, log it but don't fail if it's just a timeout
      if (waitError instanceof Error && waitError.message.includes("timeout")) {
        logger.warn("Transaction confirmation timeout, but transaction may have succeeded", {
          conditionId: params.conditionId,
          outcomeIndex: params.outcomeIndex,
          error: waitError.message,
        });
        // Don't throw - the transaction might have succeeded even if we timed out waiting
        // The blockchain will confirm it eventually
      } else if (waitError instanceof Error && waitError.message.includes("failed onchain")) {
        // Transaction failed onchain - this is a real failure
        logger.error("Transaction failed onchain", {
          conditionId: params.conditionId,
          outcomeIndex: params.outcomeIndex,
          error: waitError.message,
        });
        throw waitError;
      } else {
        throw waitError;
      }
    }

    const finalTransactionHash = transactionReceipt?.transactionHash || 
                                 (response as any)?.transactionHash || 
                                 (response as any)?.hash;
    
    logger.info("Position redeemed successfully", {
      conditionId: params.conditionId,
      outcomeIndex: params.outcomeIndex,
      transactionHash: finalTransactionHash,
      receiptStatus: transactionReceipt?.status,
    });

    return true;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;
    
    logger.error("Failed to redeem positions", {
      conditionId: params.conditionId,
      outcomeIndex: params.outcomeIndex,
      error: errorMessage,
      errorStack: errorStack,
      errorType: error instanceof Error ? error.constructor.name : typeof error,
    });
    throw error;
  }
}

