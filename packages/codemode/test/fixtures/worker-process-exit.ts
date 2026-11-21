import { CodemodeSandbox } from "../../src/runtime/host.ts";

const how = process.argv[2];
if (how !== "abort" && how !== "timeout" && how !== "close") throw new Error(`Unknown stop mode: ${how}`);
const started = performance.now();
process.on("exit", () => {
	console.log(JSON.stringify({ type: "exit", elapsedMs: performance.now() - started }));
});
const controller = new AbortController();
const TIMEOUT_MS = 300;
/** When the run was stopped: the abort or close, or the end of its timeout. Settling is timed from it. */
let stoppedAt: number | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let workerExited = false;
const sandbox = new CodemodeSandbox({
	memoryLimitBytes: 256 * 1024 * 1024,
	onWorkerStarted: (exited) => {
		void exited.then(() => {
			workerExited = true;
		});
	},
	tools: [
		{
			name: "ready",
			execute: () => {
				if (how !== "timeout") {
					timer = setTimeout(() => {
						stoppedAt = performance.now();
						if (how === "abort") controller.abort();
						else void sandbox.close();
					}, 100);
				}
			},
		},
	],
});
try {
	const executedAt = performance.now();
	const result = await sandbox.execute(
		"await tools.ready(); return 'a'.repeat(300000).indexOf('a'.repeat(10000) + 'b')",
		{ signal: controller.signal, timeoutMs: how === "timeout" ? TIMEOUT_MS : Number.POSITIVE_INFINITY },
	);
	if (how === "timeout") stoppedAt = executedAt + TIMEOUT_MS;
	if (result.ok) throw new Error("The script completed instead of being cancelled");
	await sandbox.close();
	console.log(
		JSON.stringify({
			type: "result",
			kind: result.error.kind,
			elapsedMs: performance.now() - started,
			settledMs: stoppedAt === undefined ? Number.NaN : performance.now() - stoppedAt,
			workerExited,
		}),
	);
} finally {
	clearTimeout(timer);
	await sandbox.close();
}
// Bun keeps a process alive until a terminated worker's busy loop ends, which takes seconds and grows with the load on
// the machine; what is timed here has been printed by now.
if (process.versions.bun !== undefined) process.exit(0);
