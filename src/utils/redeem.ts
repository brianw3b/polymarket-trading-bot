import { RelayClient } from "@polymarket/builder-relayer-client";
import { OperationType, SafeTransaction } from "@polymarket/builder-relayer-client";
import { Interface } from "ethers/lib/utils";
import { Logger } from "./logger";

// Contract addresses (Polygon mainnet)
const USDC_E_CONTRACT_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const CTF_CONTRACT_ADDRESS = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E";

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
 * Create a redeem transaction for winning positions
 */
export function createRedeemTx(params: RedeemParams): SafeTransaction {
  const { conditionId, outcomeIndex } = params;

  // For simple binary outcomes, parentCollectionId is empty
  const parentCollectionId = "0x" + "0".repeat(64);

  // indexSets array for the specific outcome
  // For binary markets: YES = 0 (indexSet = 1), NO = 1 (indexSet = 2)
  const indexSet = BigInt(1 << outcomeIndex);

  const iface = new Interface(ctfAbi);
  const data = iface.encodeFunctionData("redeemPositions", [
    USDC_E_CONTRACT_ADDRESS,
    parentCollectionId,
    conditionId,
    [indexSet.toString()],
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
    });

    const redeemTx = createRedeemTx(params);

    logger.info("Executing redeem transaction via relay client");
    const response = await relayClient.execute(
      [redeemTx],
      `Redeem position for condition ${params.conditionId}, outcome ${params.outcomeIndex}`
    );

    logger.info("Waiting for redeem transaction confirmation");
    await response.wait();

    logger.info("Position redeemed successfully", {
      conditionId: params.conditionId,
      outcomeIndex: params.outcomeIndex,
    });

    return true;
  } catch (error) {
    logger.error("Failed to redeem positions", {
      conditionId: params.conditionId,
      outcomeIndex: params.outcomeIndex,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

