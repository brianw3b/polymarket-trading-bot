"use client";

import { useState } from "react";
import { useTrading } from "@/providers/TradingProvider";
import useClobOrder from "@/hooks/useClobOrder";
import useActiveOrders from "@/hooks/useActiveOrders";

import ErrorState from "@/components/shared/ErrorState";
import EmptyState from "@/components/shared/EmptyState";
import LoadingState from "@/components/shared/LoadingState";
import OrderCard from "@/components/Trading/Orders/OrderCard";
import ClosedOrders from "@/components/Trading/Orders/ClosedOrders";
import Card from "@/components/shared/Card";
import { cn } from "@/utils/classNames";

type OrderTab = "open" | "closed";

export default function Orders() {
  const { clobClient, safeAddress } = useTrading();
  const [activeTab, setActiveTab] = useState<OrderTab>("open");
  const {
    data: orders,
    isLoading,
    error,
    refetch,
  } = useActiveOrders(clobClient, safeAddress as `0x${string}` | undefined);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const { cancelOrder, isSubmitting } = useClobOrder(
    clobClient,
    safeAddress as `0x${string}` | undefined
  );

  const handleCancelOrder = async (orderId: string) => {
    if (!confirm("Are you sure you want to cancel this order?")) {
      return;
    }

    setCancellingId(orderId);
    try {
      await cancelOrder(orderId);
      // Refetch orders after cancellation
      setTimeout(() => {
        refetch();
      }, 1000);
    } catch (err) {
      console.error("Failed to cancel order:", err);
      alert("Failed to cancel order. Please try again.");
    } finally {
      setCancellingId(null);
    }
  };

  const handleCancelAll = async () => {
    if (!orders || orders.length === 0) return;
    if (!confirm(`Are you sure you want to cancel all ${orders.length} orders?`)) {
      return;
    }

    try {
      for (const order of orders) {
        await cancelOrder(order.id);
      }
      setTimeout(() => {
        refetch();
      }, 1000);
    } catch (err) {
      console.error("Failed to cancel orders:", err);
      alert("Some orders failed to cancel. Please try again.");
    }
  };

  return (
    <div className="space-y-4">
      {/* Tab Navigation */}
      <div className="bg-white/5 backdrop-blur-md rounded-lg border border-white/10 p-1 flex gap-1">
        <button
          onClick={() => setActiveTab("open")}
          className={cn(
            "flex-1 py-2 px-4 rounded-md font-medium transition-all duration-200",
            activeTab === "open"
              ? "bg-blue-600 text-white shadow-lg"
              : "text-gray-300 hover:text-white hover:bg-white/5"
          )}
        >
          Open Orders {orders && orders.length > 0 && `(${orders.length})`}
        </button>
        <button
          onClick={() => setActiveTab("closed")}
          className={cn(
            "flex-1 py-2 px-4 rounded-md font-medium transition-all duration-200",
            activeTab === "closed"
              ? "bg-blue-600 text-white shadow-lg"
              : "text-gray-300 hover:text-white hover:bg-white/5"
          )}
        >
          Closed Orders
        </button>
      </div>

      {/* Tab Content */}
      {activeTab === "open" && (
        <>
          {isLoading ? (
            <LoadingState message="Loading open orders..." />
          ) : error ? (
            <ErrorState error={error} title="Error loading orders" />
          ) : !orders || orders.length === 0 ? (
            <EmptyState
              title="No Open Orders"
              message="You don't have any open limit orders."
            />
          ) : (
            <>
              {/* Header with Actions */}
              <div className="flex items-center justify-between">
                <h3 className="text-xl font-bold">Open Orders ({orders.length})</h3>
                {orders.length > 1 && (
                  <button
                    onClick={handleCancelAll}
                    disabled={isSubmitting}
                    className="px-4 py-2 bg-red-600/20 hover:bg-red-600/30 text-red-400 font-medium rounded-lg transition-colors border border-red-500/30 disabled:opacity-50"
                  >
                    Cancel All
                  </button>
                )}
              </div>

              {/* Orders List */}
              <div className="space-y-3">
                {orders.map((order) => (
                  <OrderCard
                    key={order.id}
                    order={order}
                    onCancel={handleCancelOrder}
                    isCancelling={cancellingId === order.id}
                    isSubmitting={isSubmitting}
                  />
                ))}
              </div>
            </>
          )}
        </>
      )}

      {activeTab === "closed" && <ClosedOrders />}
    </div>
  );
}
