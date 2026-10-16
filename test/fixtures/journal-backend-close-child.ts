import assert from "node:assert/strict";
import { readdirSync, readlinkSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { openSqlRunJournal } from "../../packages/workflows/src/durable/journal/sqlite-run-journal.js";

const path = resolve(process.argv[2]!);
const backend = await JournalDurableBackend.open(await openSqlRunJournal(path));
try {
	await backend.registerWorkflow({ workflowId: "closed-run", name: "close", inputs: {}, createdAt: 1, status: "running" });
	await backend.close();
	if (process.platform === "linux") {
		const retained = readdirSync("/proc/self/fd").flatMap((fd) => {
			try {
				const target = readlinkSync(`/proc/self/fd/${fd}`);
				return target.startsWith(path) ? [target] : [];
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
				throw error;
			}
		});
		assert.deepEqual(retained, [], "close must release the database, WAL and shared-memory descriptors");
	}
	rmSync(dirname(path), { recursive: true });
	console.log(backend.holderId);
} finally {
	await backend.close();
}
