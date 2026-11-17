import fs, { appendFileSync, existsSync, readFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const [mode, file] = process.argv.slice(2);
if (!file) throw new Error("missing output file");
const original = fs.promises.appendFile;
fs.promises.appendFile = async (...args: Parameters<typeof original>): Promise<void> => {
	await original(...args);
	process.exit(0);
};
syncBuiltinESMExports();

if (mode === "debug") {
	const { reportDebugAsync } = await import("../../packages/coding-agent/src/core/debug.js");
	for (const event of ["first", "second", "third"]) void reportDebugAsync("pool", event, {});
} else if (mode === "lifecycle") {
	const { installLifecycleTraceFromEnv, markLifecycleTiming } = await import(
		"../../packages/coding-agent/src/core/lifecycle-timings.js"
	);
	installLifecycleTraceFromEnv({ ATOMIC_STARTUP_TRACE: file });
	markLifecycleTiming("process-entry");
	markLifecycleTiming("engine-ready");
} else if (mode === "monitor") {
	const { startEventLoopMonitor, markEventLoopStartupComplete, markEventLoopShutdown } = await import(
		"../../packages/coding-agent/src/core/event-loop-monitor.js"
	);
	startEventLoopMonitor("host", { ATOMIC_EVENT_LOOP_BLOCK_MS: "1000", ATOMIC_EVENT_LOOP_BLOCK_LOG: file });
	markEventLoopStartupComplete();
	markEventLoopShutdown();
	process.exit(0);
} else if (mode === "debug-landed") {
	const { appendDebugRecordAsync } = await import("../../packages/coding-agent/src/core/debug.js");
	for (const step of ["same", "same", "last"]) void appendDebugRecordAsync(file, { step });
	const deadline = performance.now() + 10_000;
	while (!existsSync(file) || readFileSync(file, "utf8").split("\n").length < 4) {
		if (performance.now() > deadline) throw new Error("diagnostic appends did not land");
	}
	process.exit(0);
} else if (mode === "debug-mixed") {
	const { appendDebugRecord, appendDebugRecordAsync } = await import("../../packages/coding-agent/src/core/debug.js");
	await appendDebugRecordAsync(file, { step: "ready" });
	for (let index = 0; index < 128; index++) void appendDebugRecordAsync(file, { step: String(index) });
	appendDebugRecord(file, { step: "sync" });
	process.exit(0);
} else if (mode === "debug-sync") {
	const { appendDebugRecord } = await import("../../packages/coding-agent/src/core/debug.js");
	appendDebugRecord(file, { step: "first" });
	appendFileSync(file, `${JSON.stringify({ step: "second" })}\n`);
	process.exit(0);
}
setTimeout(() => process.exit(0), 250);
