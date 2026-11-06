/**
 * A host that opens an in-memory session store as Atomic does for a memory selection, releases one session into it, and
 * waits (#4502). Usage: `<jiti> released-history-host.ts <agentDir> <mode>`, where mode is `wait` (prints `released`,
 * then waits to be ended), `exit-on-sigterm` (the same, ending with `process.exit(143)` on SIGTERM, as Atomic's own
 * signal handlers do), or `worker` (releases in a worker thread that then ends by itself, and prints `worker exited`
 * once it has).
 */
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
// Some cases deliberately start workers before the main thread imports the SDK.

const [agentDir, mode] = (isMainThread ? process.argv.slice(2) : workerData) as [string, string];

if (isMainThread && mode !== "worker-no-listener" && mode !== "workers-late-import")
	await import("../../src/core/storage/provider.ts");

async function releaseOne(): Promise<void> {
	const { StorageProvider } = await import("../../src/core/storage/provider.ts");
	const store = await new StorageProvider().openSessionStore({ kind: "memory" }, { agentDir, domain: "sessions" });
	await store.create({ id: "s", version: 4, createdAt: "2026-11-06T00:00:00.000Z", cwd: "/repo" }, [
		{
			type: "custom",
			id: "e",
			parentId: null,
			timestamp: "2026-11-06T00:00:00.000Z",
			customType: "note",
			data: { text: "x".repeat(4096) },
		},
	]);
	await store.releaseSession?.("s");
}

if (!isMainThread) {
	await releaseOne();
	parentPort?.postMessage("released");
	if (mode === "worker-wait") setInterval(() => {}, 1000);
} else if (mode.startsWith("workers-") || mode === "worker-no-listener") {
	const workers = Array.from({ length: 3 }, () => new Worker(new URL(import.meta.url), {
		workerData: [agentDir, "worker-wait"],
	}));
	let ready = 0;
	for (const worker of workers) worker.on("message", async () => {
		if (++ready !== workers.length) return;
		if (mode === "workers-late-import") {
			await import("../../src/core/storage/provider.ts");
			// Allow the main-thread listener and already-running workers to exchange registrations.
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		process.stdout.write("all released\n");
		if (mode === "workers-sigterm") {
			process.on("SIGTERM", () => process.exit(143));
			process.kill(process.pid, "SIGTERM");
		} else {
			if (mode === "workers-terminate" || mode === "worker-no-listener")
				await Promise.all(workers.map((owner) => owner.terminate()));
			process.exit(0);
		}
	});
} else if (mode === "worker") {
	const worker = new Worker(new URL(import.meta.url), { workerData: [agentDir, "in-worker"] });
	worker.on("message", (message) => process.stdout.write(`${message}\n`));
	worker.on("exit", () => {
		process.stdout.write("worker exited\n");
		setInterval(() => {}, 1000);
	});
} else {
	if (mode === "exit-on-sigterm") process.on("SIGTERM", () => process.exit(143));
	await releaseOne();
	process.stdout.write("released\n");
	setInterval(() => {}, 1000);
}
