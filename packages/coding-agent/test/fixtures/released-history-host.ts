/**
 * A host that opens an in-memory session store as Atomic does for a memory selection, releases one session into it, and
 * waits (#4502). Usage: `<jiti> released-history-host.ts <agentDir> <mode>`, where mode is `wait` (prints `released`,
 * then waits to be ended), `exit-on-sigterm` (the same, ending with `process.exit(143)` on SIGTERM, as Atomic's own
 * signal handlers do), or `worker` (releases in a worker thread that then ends by itself, and prints `worker exited`
 * once it has).
 */
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { StorageProvider } from "../../src/core/storage/provider.ts";

const [agentDir, mode] = (isMainThread ? process.argv.slice(2) : workerData) as [string, string];

async function releaseOne(): Promise<void> {
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
