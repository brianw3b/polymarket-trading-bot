import { useQuery } from "@tanstack/react-query";
import { useWallet } from "@/providers/WalletContext";

import { QUERY_STALE_TIMES, QUERY_REFETCH_INTERVALS } from "@/constants/query";
import { USDC_E_CONTRACT_ADDRESS } from "@/constants/tokens";
import { formatUnits } from "viem";

const ERC20_ABI = [
  {
    inputs: [{ name: "account", type: "address" }],
    name: "balanceOf",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

export default function usePolygonBalances(address: string | null) {
  const { publicClient } = useWallet();

  const {
    data: usdcBalance,
    isLoading,
    error,
  } = useQuery({
    queryKey: ["usdcBalance", address],
    queryFn: async () => {
      if (!address) return null;

      return await publicClient.readContract({
        address: USDC_E_CONTRACT_ADDRESS,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [address as `0x${string}`],
      });
    },
    enabled: !!address,
    staleTime: QUERY_STALE_TIMES.BALANCE,
    refetchInterval: QUERY_REFETCH_INTERVALS.BALANCE,
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: true,
  });

  const formattedUsdcBalance = usdcBalance
    ? parseFloat(formatUnits(usdcBalance, 6))
    : 0;

  return {
    usdcBalance: formattedUsdcBalance,
    formattedUsdcBalance: formattedUsdcBalance.toFixed(2),
    rawUsdcBalance: usdcBalance,
    isLoading,
    isError: !!error,
  };
}
