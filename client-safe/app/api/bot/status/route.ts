import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

// This would typically connect to your bot process
// For now, we'll check if the bot is running by checking logs
export async function GET() {
  try {
    const logPath = path.join(process.cwd(), "..", "logs", "bot.log");
    
    let isRunning = false;
    let lastActivity = null;
    let status = "stopped";

    // Check if log file exists and has recent activity
    if (fs.existsSync(logPath)) {
      const stats = fs.statSync(logPath);
      const lastModified = stats.mtime;
      const now = new Date();
      const diffMinutes = (now.getTime() - lastModified.getTime()) / 1000 / 60;
      
      // If log was modified in last 5 minutes, consider bot running
      if (diffMinutes < 5) {
        isRunning = true;
        status = "running";
      }
      
      lastActivity = lastModified.toISOString();
    }

    // Try to read last few lines of log for status
    let recentLogs: string[] = [];
    if (fs.existsSync(logPath)) {
      try {
        const logContent = fs.readFileSync(logPath, "utf-8");
        const lines = logContent.split("\n").filter(Boolean);
        recentLogs = lines.slice(-10); // Last 10 lines
      } catch (e) {
        // Ignore read errors
      }
    }

    return NextResponse.json({
      status,
      isRunning,
      lastActivity,
      recentLogs,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to get bot status",
        status: "unknown",
        isRunning: false,
      },
      { status: 500 }
    );
  }
}










