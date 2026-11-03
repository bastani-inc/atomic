import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { decodeStream, readStreamText, spawnProcess } from "./runtime.js";

const holderScript = fileURLToPath(new URL("../fixtures/storage-sqlite-lock-holder.mjs", import.meta.url));

export interface SqliteLockHolder {
	/** Commits the holder's row, releasing the lock, and resolves once the holder has exited cleanly. */
	release(): Promise<void>;
}

/**
 * Starts another process that writes one row to the SQLite file at `path`, still in the rollback journal, and holds
 * the write lock; resolves once it holds the lock. The holder commits when `release` is called, or on its own after
 * `holdMs` when that is given, for a caller that blocks its own thread while it waits.
 */
export async function holdSqliteWriteLock(path: string, holdMs?: number): Promise<SqliteLockHolder> {
	const holder = spawnProcess(
		[process.execPath, holderScript, path, ...(holdMs === undefined ? [] : [String(holdMs)])],
		{ stdin: "pipe", stdout: "pipe", stderr: "pipe" },
	);
	const stderr = readStreamText(holder.stderr);
	const exited = async () => {
		const [code, errors] = await Promise.all([holder.exited, stderr]);
		assert.equal(code, 0, `the lock holder failed: ${errors}`);
	};
	const reader = decodeStream(holder.stdout!).getReader();
	let output = "";
	while (!output.includes("locked\n")) {
		const { done, value } = await reader.read();
		if (done) {
			await exited();
			assert.fail(`the lock holder exited before it held the lock: ${output}`);
		}
		output += value;
	}
	reader.releaseLock();
	return {
		async release() {
			holder.stdin?.end();
			await exited();
		},
	};
}
