/** Bun-compatible entry point for the split auto-compaction queue suites. */
import "./agent-session-auto-compaction-queue.setup.ts";
await import("./agent-session-auto-compaction-queue-01.suite.ts");
await import("./agent-session-auto-compaction-queue-02.suite.ts");
await import("./agent-session-auto-compaction-queue-03.suite.ts");
