# Polymarket Builder Integration Demo

A Next.js application demonstrating how to integrate Polymarket's **CLOB Client** and **Builder Relayer Client** for gasless trading with builder order attribution.

This demo shows developers how to:

- Connect users via browser wallet (MetaMask, Rabby, etc.) using **wagmi**
- Deploy a **Safe (Gnosis Safe)** wallet using the **builder-relayer-client**
- Obtain **User API Credentials** from the CLOB
- Set **token approvals** for CTF Contract, CTF Exchange, Neg Risk Exchange, and Neg Risk Adapter
- Place orders with **builder attribution** using remote signing

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Quick Start](#quick-start)
3. [Core Integration Patterns](#core-integration-patterns)
   - [Flow Overview](#flow-overview)
   - [New User Flow](#new-user-flow)
   - [Returning User Flow](#returning-user-flow)
4. [Key Implementation Details](#key-implementation-details)
   - [1. Wallet Connection & Abstraction](#1-wallet-connection--abstraction)
   - [2. Provider Architecture](#2-provider-architecture)
   - [3. Builder Config with Remote Signing](#3-builder-config-with-remote-signing)
   - [4. RelayClient Initialization](#4-relayclient-initialization)
   - [5. Safe Deployment](#5-safe-deployment)
   - [6. User API Credentials](#6-user-api-credentials)
   - [7. Token Approvals](#7-token-approvals)
   - [8. Authenticated ClobClient](#8-authenticated-clobclient)
   - [9. Placing Orders](#9-placing-orders)
5. [Project Structure](#project-structure)
6. [Environment Variables](#environment-variables)
7. [Key Dependencies](#key-dependencies)

---

## Prerequisites

Before running this demo, you need:

1. **Builder API Credentials** from Polymarket
   - Visit `polymarket.com/settings?tab=builder` to obtain your credentials
   - You'll need: `API_KEY`, `SECRET`, and `PASSPHRASE`

2. **Polygon RPC URL**
   - Any Polygon mainnet RPC (Alchemy, Infura, or public RPC)

3. **Browser Wallet**
   - MetaMask, Rabby, or any WalletConnect-compatible wallet
   - Connected to Polygon mainnet

---

## Quick Start

### Installation

```bash
npm install
```

### Environment Setup

Create `.env.local`:

```bash
# Polygon RPC endpoint
NEXT_PUBLIC_POLYGON_RPC_URL=https://polygon-rpc.com

# Builder credentials (from polymarket.com/settings?tab=builder)
POLYMARKET_BUILDER_API_KEY=your_builder_api_key
POLYMARKET_BUILDER_SECRET=your_builder_secret
POLYMARKET_BUILDER_PASSPHRASE=your_builder_passphrase
```

### Run Development Server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000)

---

## Core Integration Patterns

### Flow Overview

This application demonstrates two distinct user flows:

#### **New User Flow**

1. User connects browser wallet (EOA)
2. Initialize **RelayClient** with builder config
3. Derive Safe address (deterministic from EOA)
4. Deploy Safe using **RelayClient**
5. Obtain **User API Credentials** via temporary **ClobClient**
6. Set token approvals (USDC.e + outcome tokens) in batch transaction
7. Initialize authenticated **ClobClient** with credentials + builder config
8. Ready to trade with builder attribution

#### **Returning User Flow**

1. User connects browser wallet (EOA)
2. Initialize **RelayClient** with builder config
3. Load (or derive) existing **User API Credentials**
4. Verify Safe is deployed (skip deployment)
5. Verify token approvals (skip if already approved)
6. Initialize authenticated **ClobClient** with credentials + builder config
7. Ready to trade with builder attribution

---

## Key Implementation Details

### 1. Wallet Connection & Abstraction

**Files**: `providers/WagmiProvider.tsx`, `providers/WalletProvider.tsx`, `providers/WalletContext.tsx`

Users connect via browser extension wallets using **wagmi v3**. The `WalletProvider` wraps wagmi and provides a clean abstraction layer that exposes both **ethers** (for Polymarket SDKs) and **viem** (for efficient blockchain reads) clients.

```typescript
// providers/WalletProvider.tsx - Abstraction over wagmi
import { useConnection, useWalletClient, useConnect, useDisconnect } from "wagmi";

// Creates both viem and ethers clients automatically
export function WalletProvider({ children }) {
  const { address: eoaAddress, isConnected } = useConnection();
  const { data: wagmiWalletClient } = useWalletClient();

  // Convert wagmi's viem client to ethers signer (for Polymarket SDKs)
  const ethersSigner = useMemo(() => {
    if (!wagmiWalletClient) return null;
    const provider = new providers.Web3Provider(wagmiWalletClient);
    return provider.getSigner();
  }, [wagmiWalletClient]);

  // Expose via context
  return <WalletContext.Provider value={{
    eoaAddress,
    walletClient: wagmiWalletClient,
    ethersSigner,
    publicClient,
    connect,
    disconnect,
    isConnected
  }}>{children}</WalletContext.Provider>;
}

// Usage in components - single clean hook:
const { eoaAddress, ethersSigner, publicClient } = useWallet();
```

**Why this pattern?**

- **Single source of truth**: All wallet state accessed via `useWallet()`
- **Both client types**: Ethers for Polymarket SDKs, viem for efficient reads
- **Clean abstraction**: Components never import wagmi hooks directly
- **Easy to swap**: Want to switch from wagmi? Just update WalletProvider

---

### 2. Provider Architecture

**File**: `providers/index.tsx`

The application uses a layered provider architecture for clean separation of concerns:

```typescript
export default function Providers({ children }) {
  return (
    <WagmiProvider>           {/* Wagmi v3 configuration */}
      <QueryProvider>         {/* React Query (required by wagmi hooks) */}
        <WalletProvider>      {/* Wallet abstraction (ethers + viem) */}
          <TradingProvider>   {/* Trading session & clients */}
            {children}
          </TradingProvider>
        </WalletProvider>
      </QueryProvider>
    </WagmiProvider>
  );
}
```

**Provider Responsibilities:**

| Provider          | Purpose                                   | Exports             |
| ----------------- | ----------------------------------------- | ------------------- |
| `WagmiProvider`   | Wagmi v3 config (chains, connectors)      | -                   |
| `QueryProvider`   | React Query setup (wagmi depends on this) | -                   |
| `WalletProvider`  | Wallet state + client creation            | `useWallet()` hook  |
| `TradingProvider` | Trading session, clob/relay clients       | `useTrading()` hook |

**Key Benefits:**

- **Centralized state**: `useWallet()` and `useTrading()` hooks provide everything
- **No prop drilling**: State accessible anywhere in component tree
- **Clean separation**: Each provider has a single responsibility
- **Type-safe**: Full TypeScript support with proper context types

---

### 3. Builder Config with Remote Signing

**File**: `app/api/polymarket/sign/route.ts`

Builder credentials are stored server-side and accessed via a remote signing endpoint. This keeps your builder credentials secure while enabling order attribution or relay authentication.

```typescript
// Server-side API route
import {
  BuilderApiKeyCreds,
  buildHmacSignature,
} from "@polymarket/builder-signing-sdk";

const BUILDER_CREDENTIALS: BuilderApiKeyCreds = {
  key: process.env.POLYMARKET_BUILDER_API_KEY!,
  secret: process.env.POLYMARKET_BUILDER_SECRET!,
  passphrase: process.env.POLYMARKET_BUILDER_PASSPHRASE!,
};

export async function POST(request: NextRequest) {
  const { method, path, body } = await request.json();
  const sigTimestamp = Date.now().toString();

  const signature = buildHmacSignature(
    BUILDER_CREDENTIALS.secret,
    parseInt(sigTimestamp),
    method,
    path,
    body
  );

  return NextResponse.json({
    POLY_BUILDER_SIGNATURE: signature,
    POLY_BUILDER_TIMESTAMP: sigTimestamp,
    POLY_BUILDER_API_KEY: BUILDER_CREDENTIALS.key,
    POLY_BUILDER_PASSPHRASE: BUILDER_CREDENTIALS.passphrase,
  });
}
```

**Why remote signing?**

- Builder credentials never exposed to client
- Secure HMAC signature generation
- Required for builder order attribution (with ClobClient) or authentication (RelayClient)

---

### 4. RelayClient Initialization

**File**: `hooks/useRelayClient.ts`

The **RelayClient** is initialized with the user's EOA signer and builder config. It's used for Safe deployment, token approvals, and CTF operations.

```typescript
import { RelayClient } from "@polymarket/builder-relayer-client";
import { BuilderConfig } from "@polymarket/builder-signing-sdk";
import { useWallet } from "@/providers/WalletContext";

export default function useRelayClient() {
  const { ethersSigner, eoaAddress } = useWallet();

  const initializeRelayClient = async () => {
    if (!ethersSigner || !eoaAddress) {
      throw new Error("Wallet not connected");
    }

    const builderConfig = new BuilderConfig({
      remoteBuilderConfig: {
        url: "/api/polymarket/sign", // Your remote signing endpoint
      },
    });

    const relayClient = new RelayClient(
      RELAYER_URL,
      137, // Polygon chain ID
      ethersSigner, // From WalletProvider context
      builderConfig
    );

    return relayClient;
  };

  return { initializeRelayClient };
}
```

**Key Points:**

- Uses `ethersSigner` from `WalletProvider`
- Builder config for authentication
- Used for Safe deployment and approvals
- Persisted throughout trading session

---

### 5. Safe Deployment

**File**: `hooks/useSafeDeployment.ts`

The Safe address is deterministically derived from the user's EOA, then deployed if it doesn't exist.

```typescript
import { deriveSafe } from "@polymarket/builder-relayer-client/dist/builder/derive";
import { getContractConfig } from "@polymarket/builder-relayer-client/dist/config";

// Step 1: Derive Safe address (deterministic)
const config = getContractConfig(137); // Polygon
const safeAddress = deriveSafe(eoaAddress, config.SafeContracts.SafeFactory);

// Step 2: Check if Safe is deployed
const deployed = await relayClient.getDeployed(safeAddress);

// Step 3: Deploy Safe if needed (prompts user signature)
if (!deployed) {
  const response = await relayClient.deploy();
  const result = await response.wait();
  console.log("Safe deployed at:", result.proxyAddress);
}
```

**Important:**

- Safe address is **deterministic** - same EOA always gets same Safe address
- Safe is the "funder" address that holds USDC.e and outcome tokens
- One-time deployment per EOA (if not already done when user visited Polymarket.com)
- User signs transaction via their wallet

---

### 6. User API Credentials

**File**: `hooks/useUserApiCredentials.ts`

User API Credentials are obtained by creating a temporary **ClobClient** and calling `deriveApiKey()` or `createApiKey()`.

```typescript
import { ClobClient } from "@polymarket/clob-client";

// Create temporary CLOB client (no credentials yet)
const tempClient = new ClobClient(
  "https://clob.polymarket.com",
  137, // Polygon chain ID
  signer
);

// Try to derive existing credentials (for returning users)
let creds;
try {
  creds = await tempClient.deriveApiKey(); // Prompts user signature
} catch (error) {
  // If derive fails, create new credentials
  creds = await tempClient.createApiKey(); // Prompts user signature
}

// creds = { key: string, secret: string, passphrase: string }
```

**Flow:**

1. **First-time users**: `createApiKey()` creates new credentials
2. **Returning users**: `deriveApiKey()` retrieves existing credentials
3. Both methods require user signature (EIP-712)
4. Credentials are stored in localStorage for future sessions

**Important:**

Credentials alone are not enough to place new orders. However, they can be used to view orders and to cancel limit orders. Storing the user's credentials in localStorage is **not recommended for production** due to XSS vulnerability risks. This demo prioritizes simplicity over security—in production, use secure httpOnly cookies or server-side session management instead.

**Why temporary client?**

- Credentials are needed to create the authenticated client
- Temporary client is destroyed after obtaining credentials

---

### 7. Token Approvals

**Files**: `hooks/useTokenApprovals.ts`, `utils/approvals.ts`

Before trading, the Safe must approve **multiple contracts** to spend USDC.e and manage outcome tokens. This involves setting approvals for both **ERC-20 (USDC.e)** and **ERC-1155 (outcome tokens)**.

#### Required Approvals

**USDC.e (ERC-20) Approvals:**

- CTF Contract: `0x4d97dcd97ec945f40cf65f87097ace5ea0476045`
- CTF Exchange: `0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E`
- Neg Risk CTF Exchange: `0xC5d563A36AE78145C45a50134d48A1215220f80a`
- Neg Risk Adapter: `0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296`

**Outcome Token (ERC-1155) Approvals:**

- CTF Exchange: `0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E`
- Neg Risk CTF Exchange: `0xC5d563A36AE78145C45a50134d48A1215220f80a`
- Neg Risk Adapter: `0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296`

#### Implementation

```typescript
import { createAllApprovalTxs, checkAllApprovals } from "@/utils/approvals";

// Step 1: Check existing approvals
const approvalStatus = await checkAllApprovals(safeAddress);

if (approvalStatus.allApproved) {
  console.log("All approvals already set");
  // Skip approval step
} else {
  // Step 2: Create approval transactions
  const approvalTxs = createAllApprovalTxs();
  // Returns array of SafeTransaction objects

  // Step 3: Execute all approvals in a single batch
  const response = await relayClient.execute(
    approvalTxs,
    "Set all token approvals for trading"
  );

  await response.wait();
  console.log("All approvals set successfully");
}
```

#### Approval Transaction Structure

Each approval transaction is a `SafeTransaction` using **viem's** `encodeFunctionData`:

```typescript
import { encodeFunctionData, erc20Abi } from "viem";

// ERC-20 approval (USDC.e)
{
  to: USDC_E_CONTRACT_ADDRESS,
  operation: OperationType.Call,
  data: encodeFunctionData({
    abi: erc20Abi,
    functionName: 'approve',
    args: [spenderAddress as `0x${string}`, BigInt(MAX_UINT256)]
  }),
  value: '0'
}

// ERC-1155 approval (outcome tokens)
{
  to: CTF_CONTRACT_ADDRESS,
  operation: OperationType.Call,
  data: encodeFunctionData({
    abi: erc1155Abi,
    functionName: 'setApprovalForAll',
    args: [operatorAddress as `0x${string}`, true]
  }),
  value: '0'
}
```

#### Why Multiple Approvals?

Polymarket's trading system uses different contracts for different market types:

- **CTF Contract**: Manages outcome tokens (ERC-1155)
- **CTF Exchange**: Standard binary markets
- **Neg Risk CTF Exchange**: Negative risk markets (mutually exclusive outcomes)
- **Neg Risk Adapter**: Converts between neg risk and standard markets

Setting all approvals upfront ensures:

- Users can trade in any market type
- One-time setup (approvals persist across sessions)
- Gasless execution via RelayClient
- Single user signature for all approvals

#### Checking Approvals

Before setting approvals, the app checks on-chain state:

```typescript
// Check USDC.e approval
const allowance = await publicClient.readContract({
  address: USDC_E_ADDRESS,
  abi: ERC20_ABI,
  functionName: "allowance",
  args: [safeAddress, spenderAddress],
});

const isApproved = allowance >= threshold; // 1000000000000 (1M USDC.e)

// Check outcome token approval
const isApprovedForAll = await publicClient.readContract({
  address: CTF_CONTRACT_ADDRESS,
  abi: ERC1155_ABI,
  functionName: "isApprovedForAll",
  args: [safeAddress, operatorAddress],
});
```

**Key Points:**

- Uses **batch execution** via `relayClient.execute()` for gas efficiency
- Sets **unlimited approvals** (MaxUint256) for ERC-20 tokens
- Sets **operator approvals** for ERC-1155 outcome tokens
- One-time setup per Safe (persists across sessions)
- User signs once to approve all transactions
- Gasless for the user

---

### 8. Authenticated ClobClient

**File**: `hooks/useClobClient.ts`

After obtaining User API Credentials, create the authenticated **ClobClient** with builder config.

```typescript
import { ClobClient } from "@polymarket/clob-client";
import { BuilderConfig } from "@polymarket/builder-signing-sdk";
import { useWallet } from "@/providers/WalletContext";
import useSafeDeployment from "@/hooks/useSafeDeployment";

export default function useClobClient(
  tradingSession: TradingSession | null,
  isTradingSessionComplete: boolean | undefined
) {
  // Get ethers signer from WalletProvider
  const { eoaAddress, ethersSigner } = useWallet();
  const { derivedSafeAddressFromEoa } = useSafeDeployment();

  const clobClient = useMemo(() => {
    if (
      !ethersSigner ||
      !eoaAddress ||
      !derivedSafeAddressFromEoa ||
      !isTradingSessionComplete ||
      !tradingSession?.apiCredentials
    ) {
      return null;
    }

    const builderConfig = new BuilderConfig({
      remoteBuilderConfig: {
        url: "/api/polymarket/sign",
      },
    });

    return new ClobClient(
      CLOB_API_URL,
      137, // Polygon chain ID
      ethersSigner, // From WalletProvider
      tradingSession.apiCredentials, // { key, secret, passphrase }
      2, // signatureType = 2 for Safe proxy funder
      derivedSafeAddressFromEoa, // funder address
      undefined, // mandatory placeholder
      false,
      builderConfig // Builder order attribution
    );
  }, [
    eoaAddress,
    ethersSigner,
    derivedSafeAddressFromEoa,
    isTradingSessionComplete,
    tradingSession?.apiCredentials,
  ]);

  return { clobClient };
}
```

**Parameters Explained:**

- **ethersSigner**: From `WalletProvider` context (automatic ethers conversion)
- **userApiCredentials**: Obtained from trading session
- **signatureType = 2**: For Safe proxy funder
- **safeAddress**: The Safe address that holds funds
- **builderConfig**: Enables order attribution

**This is the persistent client used for all trading operations.**

---

### 9. Placing Orders

**File**: `hooks/useClobOrder.ts`

With the authenticated ClobClient, you can place orders with builder attribution.

```typescript
// Create order
const order = {
  tokenID: "0x...", // Outcome token address
  price: 0.65, // Price in decimal (65 cents)
  size: 10, // Number of shares
  side: "BUY", // or 'SELL'
  feeRateBps: 0,
  expiration: 0, // 0 = Good-til-Cancel
  taker: "0x0000000000000000000000000000000000000000",
};

// Submit order (prompts user signature)
const response = await clobClient.createAndPostOrder(
  order,
  { negRisk: false }, // Market-specific flag
  OrderType.GTC
);

console.log("Order ID:", response.orderID);
```

**Key Points:**

- Orders are signed by the user's EOA
- Executed from the Safe address (funder)
- Builder attribution is automatic via builderConfig
- Gasless execution (no gas fees for users)

**Cancel Order:**

```typescript
await clobClient.cancelOrder({ orderID: "order_id_here" });
```

---

## Project Structure

### Core Implementation Files

```
polymarket-safe-trader/
├── app/
│   ├── api/
│   │   └── polymarket/
│   │       └── sign/
│   │           └── route.ts              # Remote signing endpoint
│   ├── layout.tsx                        # Root layout with providers
│   └── page.tsx                          # Main application UI
│
├── providers/
│   ├── index.tsx                         # Provider composition/nesting
│   ├── WagmiProvider.tsx                 # Wagmi v3 configuration
│   ├── QueryProvider.tsx                 # React Query configuration
│   ├── WalletContext.tsx                 # Wallet context definition
│   ├── WalletProvider.tsx                # Wallet abstraction (ethers + viem)
│   └── TradingProvider.tsx               # Trading state consolidation
│
├── hooks/
│   ├── useTradingSession.ts              # Session orchestration (main flow)
│   ├── useRelayClient.ts                 # RelayClient initialization
│   ├── useSafeDeployment.ts              # Safe deployment logic
│   ├── useUserApiCredentials.ts          # User API credential derivation
│   ├── useTokenApprovals.ts              # Token approval management
│   ├── useClobClient.ts                  # Authenticated CLOB client
│   ├── useClobOrder.ts                   # Order placement/cancellation
│   ├── useUserPositions.ts               # Fetch user positions
│   ├── useActiveOrders.ts                # Fetch active orders
│   └── useHighVolumeMarkets.ts           # Fetch high volume markets
│
├── components/
│   ├── Header/                           # Wallet connection UI
│   ├── PolygonAssets/                    # Balance display
│   ├── TradingSession/                   # Session initialization UI
│   └── Trading/                          # Markets, Orders, Positions
│
├── utils/
│   ├── session.ts                        # Session persistence (localStorage)
│   ├── approvals.ts                      # Token approval utilities
│   └── redeem.ts                         # Position redemption
│
└── constants/
    ├── polymarket.ts                     # API URLs and constants
    └── tokens.ts                         # Token addresses
```

### Key Providers & Hooks

#### **TradingProvider** - Main Trading Orchestrator

**File**: `providers/TradingProvider.tsx`

This provider consolidates all trading-related state and clients in one place:

```typescript
export function useTrading() {
  const ctx = useContext(TradingContext);
  if (!ctx) throw new Error("useTrading must be used within TradingProvider");
  return ctx;
}

// Internally coordinates:
// - useTradingSession (session lifecycle)
// - useClobClient (authenticated CLOB client)
// - useSafeDeployment (Safe address derivation)
// - All trading state management

// Usage in components:
const {
  tradingSession,
  currentStep,
  sessionError,
  isTradingSessionComplete,
  initializeTradingSession,
  endTradingSession,
  clobClient,
  relayClient,
  eoaAddress,
  safeAddress,
} = useTrading();
```

#### **useTradingSession** - Session Lifecycle

**File**: `hooks/useTradingSession.ts`

Orchestrates the trading session initialization flow:

1. Initialize RelayClient with builder config
2. Derive Safe address from EOA
3. Check if Safe is deployed → deploy if needed
4. Get User API Credentials → derive or create
5. Check token approvals → approve if needed (batch)
6. Save session to localStorage
7. Return session state for ClobClient initialization

**Key Pattern**: Components use `useTrading()` instead of individual hooks. This provides a clean, consolidated API for all trading operations.

---

## Environment Variables

Create `.env.local`:

```bash
# Required: Polygon RPC
NEXT_PUBLIC_POLYGON_RPC_URL=https://polygon-rpc.com

# Required: Builder credentials (from polymarket.com/settings?tab=builder)
POLYMARKET_BUILDER_API_KEY=your_builder_api_key
POLYMARKET_BUILDER_SECRET=your_builder_secret
POLYMARKET_BUILDER_PASSPHRASE=your_builder_passphrase
```

---

## Key Dependencies

| Package                                                                                                  | Version  | Purpose                                          |
| -------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------ |
| [`@polymarket/clob-client`](https://github.com/Polymarket/clob-client)                                   | ^4.22.8  | Order placement, User API credentials            |
| [`@polymarket/builder-relayer-client`](https://www.npmjs.com/package/@polymarket/builder-relayer-client) | ^0.0.6   | Safe deployment, token approvals, CTF operations |
| [`@polymarket/builder-signing-sdk`](https://www.npmjs.com/package/@polymarket/builder-signing-sdk)       | ^0.0.8   | Builder credential HMAC signatures               |
| [`wagmi`](https://wagmi.sh/)                                                                             | ^3.0.1   | React hooks for wallet connection                |
| [`viem`](https://viem.sh/)                                                                               | ^2.39.2  | Ethereum interactions, RPC calls                 |
| [`ethers`](https://docs.ethers.org/v5/)                                                                  | ^5.8.0   | Wallet signing, EIP-712 messages                 |
| [`@tanstack/react-query`](https://tanstack.com/query)                                                    | ^5.90.10 | Server state management                          |
| [`next`](https://nextjs.org/)                                                                            | 16.0.3   | React framework, API routes                      |

---

## Architecture Diagram

### Provider Stack

```
┌─────────────────────────────────────────┐
│         WagmiProvider (v3)              │  ← Wallet connection config
│  ┌───────────────────────────────────┐  │
│  │       QueryProvider               │  │  ← React Query (for wagmi)
│  │  ┌─────────────────────────────┐  │  │
│  │  │     WalletProvider          │  │  │  ← Ethers + Viem clients
│  │  │  ┌───────────────────────┐  │  │  │
│  │  │  │  TradingProvider      │  │  │  │  ← Trading session & clients
│  │  │  │                       │  │  │  │
│  │  │  │   App Components      │  │  │  │
│  │  │  └───────────────────────┘  │  │  │
│  │  └─────────────────────────────┘  │  │
│  └───────────────────────────────────┘  │
└─────────────────────────────────────────┘
```

### Trading Session Flow

```
User's Browser Wallet (EOA)
         ↓
    [WalletProvider]
    Creates: ethersSigner, publicClient
         ↓
    [TradingProvider]
         ↓
┌────────────────────────────────────────────────────┐
│  Trading Session Initialization                     │
├────────────────────────────────────────────────────┤
│  1. Initialize RelayClient (with builder config)   │
│  2. Derive Safe address from EOA                   │
│  3. Check if Safe deployed → deploy if needed      │
│  4. Get User API Credentials (derive or create)    │
│  5. Set token approvals (batch execution):         │
│     - USDC.e → 4 spenders (ERC-20)                 │
│     - Outcome tokens → 3 operators (ERC-1155)      │
│  6. Save session to localStorage                   │
└────────────────────────────────────────────────────┘
         ↓
┌────────────────────────────────────────────────────┐
│  Authenticated ClobClient                           │
├────────────────────────────────────────────────────┤
│  - User API Credentials                            │
│  - Builder Config (remote signing)                 │
│  - Safe address (funder)                           │
│  - EOA signer (from WalletProvider)                │
└────────────────────────────────────────────────────┘
         ↓
    Place Orders
    (Standard + Neg Risk markets)
    (with builder attribution)
```

---

## Troubleshooting

### "Wallet not connected"

- Ensure browser wallet is installed and connected
- Switch wallet to Polygon mainnet (Chain ID 137)

### "Failed to initialize relay client"

- Check builder credentials in `.env.local`
- Verify `/api/polymarket/sign` endpoint is accessible
- Check browser console for errors

### "Safe deployment failed"

- Check Polygon RPC URL is valid
- User must approve signature in wallet
- Verify builder credentials are configured correctly
- Check browser console for relay service errors

### "Token approval failed"

- Safe must be deployed first
- User must approve transaction signature in wallet
- Verify builder relay service is operational

### Orders not appearing

- Verify trading session is complete
- Check Safe has USDC.e balance
- Wait 2-3 seconds for CLOB sync

---

## Resources

### Polymarket Documentation

- [CLOB Client Docs](https://docs.polymarket.com/developers/CLOB/clients)
- [Builder Program](https://docs.polymarket.com/developers/builder-program)
- [Authentication](https://docs.polymarket.com/developers/CLOB/authentication)
- [Order Placement](https://docs.polymarket.com/quickstart/orders/first-order)

### GitHub Repositories

- [clob-client](https://github.com/Polymarket/clob-client)
- [builder-relayer-client](https://www.npmjs.com/package/@polymarket/builder-relayer-client)

### Other Resources

- [wagmi Documentation](https://wagmi.sh/)
- [Safe (Gnosis Safe)](https://docs.safe.global/)
- [EIP-712 Specification](https://eips.ethereum.org/EIPS/eip-712)

---

## Support

Questions or issues? Reach out on Telegram: **[@notyrjo](https://t.me/notyrjo)**

---

## License

MIT

---

**Built for builders exploring the Polymarket ecosystem**
