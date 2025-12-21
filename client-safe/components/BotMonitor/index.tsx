"use client";

import { useState, useEffect } from "react";
import Card from "@/components/shared/Card";
import Badge from "@/components/shared/Badge";
import LoadingState from "@/components/shared/LoadingState";
import ErrorState from "@/components/shared/ErrorState";
import { cn } from "@/utils/classNames";

interface BotStatus {
  status: string;
  isRunning: boolean;
  lastActivity: string | null;
  recentLogs: string[];
}

export default function BotMonitor() {
  const [status, setStatus] = useState<BotStatus | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);

  const fetchStatus = async () => {
    try {
      setIsLoading(true);
      const response = await fetch("/api/bot/status");
      if (!response.ok) throw new Error("Failed to fetch bot status");
      const data = await response.json();
      setStatus(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchStatus();
    
    if (autoRefresh) {
      const interval = setInterval(fetchStatus, 5000); // Refresh every 5 seconds
      return () => clearInterval(interval);
    }
  }, [autoRefresh]);

  if (isLoading && !status) {
    return <LoadingState message="Loading bot status..." />;
  }

  if (error && !status) {
    return <ErrorState error={error} title="Failed to load bot status" />;
  }

  const statusColor = status?.isRunning
    ? "bg-green-500"
    : status?.status === "stopped"
    ? "bg-gray-500"
    : "bg-yellow-500";

  return (
    <Card className="p-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-2xl font-bold">Bot Monitor</h2>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
              className="rounded"
            />
            Auto-refresh
          </label>
          <button
            onClick={fetchStatus}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
          >
            Refresh
          </button>
        </div>
      </div>

      {/* Status Badge */}
      <div className="flex items-center gap-3 mb-6">
        <div className={cn("w-3 h-3 rounded-full", statusColor)} />
        <span className="text-lg font-semibold capitalize">
          Status: {status?.status || "Unknown"}
        </span>
        <Badge
          variant={status?.isRunning ? "success" : "warning"}
          className="ml-2"
        >
          {status?.isRunning ? "Running" : "Stopped"}
        </Badge>
      </div>

      {/* Last Activity */}
      {status?.lastActivity && (
        <div className="mb-6 p-4 bg-white/5 rounded-lg">
          <p className="text-sm text-gray-400 mb-1">Last Activity</p>
          <p className="text-sm">
            {new Date(status.lastActivity).toLocaleString()}
          </p>
        </div>
      )}

      {/* Recent Logs */}
      {status?.recentLogs && status.recentLogs.length > 0 && (
        <div>
          <h3 className="text-lg font-semibold mb-3">Recent Activity</h3>
          <div className="bg-black/50 rounded-lg p-4 font-mono text-xs max-h-64 overflow-y-auto">
            {status.recentLogs.map((log, idx) => (
              <div key={idx} className="text-gray-300 mb-1">
                {log}
              </div>
            ))}
          </div>
        </div>
      )}

      {(!status?.recentLogs || status.recentLogs.length === 0) && (
        <div className="text-center py-8 text-gray-400">
          No recent activity
        </div>
      )}
    </Card>
  );
}










