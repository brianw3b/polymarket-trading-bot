import { ClobClient } from "@polymarket/clob-client";
import { Side, OrderType, UserOrder } from "@polymarket/clob-client";
import { Logger } from "../utils/logger";
import { TradingDecision } from "../strategies/base";

export class OrderExecutor {
  constructor(
    private clobClient: ClobClient,
    private logger: Logger
  ) {}

  async executeOrder(decision: TradingDecision): Promise<string | null> {
    try {
      // Additional validation
      if (!decision || !decision.tokenId || decision.price === undefined || decision.size === undefined) {
        this.logger.error("Invalid decision: missing required fields", { decision });
        return null;
      }

      const side = decision.action === "BUY_YES" || decision.action === "BUY_NO" 
        ? Side.BUY 
        : Side.SELL;

      // Enhanced price validation
      if (
        typeof decision.price !== "number" ||
        isNaN(decision.price) ||
        !isFinite(decision.price) ||
        decision.price <= 0 ||
        decision.price >= 1
      ) {
        this.logger.warn("Invalid price for order", {
          price: decision.price,
          tokenId: decision.tokenId,
          action: decision.action,
        });
        return null;
      }

      // Enhanced size validation
      if (
        typeof decision.size !== "number" ||
        isNaN(decision.size) ||
        !isFinite(decision.size) ||
        decision.size <= 0
      ) {
        this.logger.warn("Invalid size for order", {
          size: decision.size,
          tokenId: decision.tokenId,
          action: decision.action,
        });
        return null;
      }

      const order: UserOrder = {
        tokenID: decision.tokenId,
        price: decision.price,
        size: decision.size,
        side,
        feeRateBps: 0,
        expiration: 0,
        taker: "0x0000000000000000000000000000000000000000",
      };

      this.logger.info("Submitting order", {
        action: decision.action,
        tokenId: decision.tokenId,
        price: decision.price,
        size: decision.size,
        side,
        reason: decision.reason,
        order: {
          tokenID: order.tokenID,
          price: order.price,
          size: order.size,
          side: order.side,
        },
      });

      let response;
      try {
        // Add timeout wrapper for order submission (30 seconds)
        const timeoutPromise = new Promise((_, reject) => {
          setTimeout(() => reject(new Error("Order submission timeout")), 30000);
        });

        response = await Promise.race([
          this.clobClient.createAndPostOrder(
            order,
            { negRisk: false },
            OrderType.GTC
          ),
          timeoutPromise,
        ]) as any;
      } catch (orderError: any) {
        const errorData = orderError?.response?.data || orderError?.data || {};
        const errorMessage = errorData?.error || orderError?.message || String(orderError);
        
        this.logger.error("Order submission error details", {
          error: errorMessage,
          status: orderError?.response?.status || orderError?.status,
          statusText: orderError?.response?.statusText || orderError?.statusText,
          data: errorData,
          order: {
            tokenID: order.tokenID,
            price: order.price,
            size: order.size,
            side: order.side,
          },
        });

        if (errorMessage === "invalid signature" || errorMessage?.includes("signature")) {
          this.logger.error("Signature validation failed", {
            note: "Polymarket uses gasless trading - only USDC.e needed, not MATIC",
            suggestions: [
              "1. Verify wallet private key in .env is correct",
              "2. Check API credentials are valid (bot should create them automatically)",
              "3. Ensure wallet has USDC.e for trading (not MATIC - gasless!)",
              "4. Check if token approvals are needed - visit Polymarket to approve USDC.e",
              "5. Verify builder credentials if using builder attribution",
              "6. Try restarting the bot to refresh credentials",
            ],
          });
        } else if (errorMessage?.includes("insufficient") || errorMessage?.includes("balance")) {
          this.logger.error("Insufficient balance", {
            note: "Wallet needs USDC.e for trading (Polymarket is gasless, no MATIC needed)",
            suggestion: "Fund wallet with USDC.e on Polygon. No MATIC required for gasless trading.",
          });
        } else if (errorMessage?.includes("approval") || errorMessage?.includes("allowance")) {
          this.logger.error("Token approval needed", {
            note: "You need to approve tokens before trading (gasless, no MATIC needed)",
            suggestion: "Visit Polymarket website and approve USDC.e and market tokens. Approvals are gasless too!",
          });
        }

        return null;
      }

      if (response.orderID) {
        this.logger.info("Order submitted successfully", {
          orderId: response.orderID,
          action: decision.action,
          tokenId: decision.tokenId,
          price: decision.price,
          size: decision.size,
        });
        return response.orderID;
      } else {
        throw new Error("Order submission failed - no order ID returned");
      }
    } catch (error) {
      this.logger.error("Failed to execute order", {
        decision,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  async cancelOrder(orderId: string): Promise<boolean> {
    try {
      await this.clobClient.cancelOrder({ orderID: orderId });
      this.logger.info("Order cancelled successfully", { orderId });
      return true;
    } catch (error) {
      this.logger.error("Failed to cancel order", {
        orderId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  async getActiveOrders(): Promise<any[]> {
    try {
      // Add timeout wrapper for getOpenOrders (10 seconds)
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error("getActiveOrders timeout after 10 seconds")), 10000);
      });

      const orders = await Promise.race([
        this.clobClient.getOpenOrders(),
        timeoutPromise,
      ]) as any[];

      return orders || [];
    } catch (error) {
      this.logger.error("Failed to fetch active orders", {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }
}



