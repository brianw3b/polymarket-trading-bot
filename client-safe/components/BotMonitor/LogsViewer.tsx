"use client";

import { useState, useEffect } from "react";
import Card from "@/components/shared/Card";
import LoadingState from "@/components/shared/LoadingState";
import ErrorState from "@/components/shared/ErrorState";
import { cn } from "@/utils/classNames";

interface LogsViewerProps {
  logType?: "bot" | "error" | "test";
  lines?: number;
}

export default function LogsViewer({
  logType = "bot",
  lines = 200,
}: LogsViewerProps) {
  const [logs, setLogs] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [filter, setFilter] = useState("");

  const fetchLogs = async () => {
    try {
      setIsLoading(true);
      const response = await fetch(
        `/api/bot/logs?type=${logType}&lines=${lines}`
      );
      if (!response.ok) throw new Error("Failed to fetch logs");
      const data = await response.json();
      setLogs(data.logs || []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchLogs();
    
    if (autoRefresh) {
      const interval = setInterval(fetchLogs, 3000); // Refresh every 3 seconds
      return () => clearInterval(interval);
    }
  }, [logType, lines, autoRefresh]);

  const filteredLogs = filter
    ? logs.filter((log) =>
        log.toLowerCase().includes(filter.toLowerCase())
      )
    : logs;

  const logTypeLabels = {
    bot: "Bot Logs",
    error: "Error Logs",
    test: "Test Logs",
  };

  if (isLoading && logs.length === 0) {
    return <LoadingState message="Loading logs..." />;
  }

  return (
    <Card className="p-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-2xl font-bold">{logTypeLabels[logType]}</h2>
        <div className="flex items-center gap-3">
          <input
            type="text"
            placeholder="Filter logs..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-sm"
          />
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
            onClick={fetchLogs}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
          >
            Refresh
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-4">
          <ErrorState error={error} title="Failed to load logs" />
        </div>
      )}

      <div className="bg-black/50 rounded-lg p-4 font-mono text-xs max-h-96 overflow-y-auto">
        {filteredLogs.length === 0 ? (
          <div className="text-center py-8 text-gray-400">No logs found</div>
        ) : (
          filteredLogs.map((log, idx) => {
            const isError = log.toLowerCase().includes("error");
            const isWarning = log.toLowerCase().includes("warn");
            const isInfo = log.toLowerCase().includes("info");

            return (
              <div
                key={idx}
                className={cn(
                  "mb-1 break-words",
                  isError && "text-red-400",
                  isWarning && "text-yellow-400",
                  isInfo && "text-blue-400",
                  !isError && !isWarning && !isInfo && "text-gray-300"
                )}
              >
                {log}
              </div>
            );
          })
        )}
      </div>

      {filteredLogs.length > 0 && (
        <div className="mt-3 text-sm text-gray-400 text-center">
          Showing {filteredLogs.length} of {logs.length} log lines
        </div>
      )}
    </Card>
  );
}

