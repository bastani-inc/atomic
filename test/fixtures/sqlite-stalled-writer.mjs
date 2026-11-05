// A writer that waits for "go" on stdin, then tries one transaction and prints its outcome as JSON: how long it
// waited (from "go"), and the storage error it failed with, serialized by `serializeStorageError`, if any.
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { fsCache: false });
const { openNodeSqliteDatabase } = await jiti.import(
	fileURLToPath(new URL("../../packages/coding-agent/src/core/storage/node-sqlite.ts", import.meta.url)),
);
const { serializeStorageError } = await jiti.import(
	fileURLToPath(new URL("../../packages/coding-agent/src/core/storage/errors.ts", import.meta.url)),
);
const [path, lockWaitMs] = process.argv.slice(2);
const database = await openNodeSqliteDatabase(path, { busyTimeoutMs: 0, lockWaitMs: Number(lockWaitMs) });
process.stdout.write("ready\n");
await new Promise((resolve) => process.stdin.once("data", resolve));
const started = performance.now();
let error = null;
try {
	await database.transaction((tx) => tx.run("INSERT INTO probe VALUES (1)"));
} catch (cause) {
	error = serializeStorageError(cause);
}
process.stdout.write(`${JSON.stringify({ waitedMs: performance.now() - started, error })}\n`);
await database.close().catch(() => {});
