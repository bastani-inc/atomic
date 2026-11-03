/**
 * Runs `test/fixtures/native-command-output-retention.mjs` in a child process and checks that the process's resident
 * memory stays flat across its batches of shell commands (#4215). The native command output retention suites share it;
 * they are split by terminal kind so their child processes run in parallel across workers.
 */
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { spawnSyncCollect } from "./runtime.js";

const fixture = fileURLToPath(new URL("../fixtures/native-command-output-retention.mjs", import.meta.url));
const BATCHES = 5;
const COMMANDS = 20;
const BYTES = 1_000_000;
/** How long the child process may take to run its batches. */
const CHILD_TIMEOUT_MS = 150_000;

interface Batch {
	readonly owner: number;
	readonly rss: number;
	readonly heapUsed: number;
	/** Null for terminal commands, whose output a terminal reformats. */
	readonly readBack: boolean | null;
}

export function runBatches(open: boolean, pty = false): readonly Batch[] {
	const result = spawnSyncCollect([process.execPath, "--expose-gc", fixture], {
		env: {
			// Resident memory measures what the supervisor keeps only if glibc gives freed buffers back. Few malloc arenas:
			// each command's reader threads can otherwise grow per-thread arenas by a few MB in a step. A fixed mmap
			// threshold: glibc otherwise raises it after the first large free, so later output buffers come from the heap
			// and stay resident once freed (CI saw a terminal-command run grow 52 MB with every buffer released).
			MALLOC_ARENA_MAX: "2",
			MALLOC_MMAP_THRESHOLD_: "131072",
			OWNERS: String(BATCHES),
			COMMANDS: String(COMMANDS),
			BYTES: String(BYTES),
			...(open ? { OPEN: "1" } : {}),
			...(pty ? { PTY: "1" } : {}),
		},
		timeout: CHILD_TIMEOUT_MS,
	});
	assert.equal(result.exitCode, 0, result.stderr.toString());
	return result.stdout
		.toString()
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as Batch);
}

export function assertFlat(batches: readonly Batch[], what: string): void {
	assert.equal(batches.length, BATCHES);
	assert.ok(
		batches.every((batch) => batch.readBack !== false),
		"each batch's first pipe command reads back its exact output",
	);
	// From the first batch on, the process has loaded everything it needs. A supervisor that keeps a copy of its
	// finished commands' output grows by at least what they printed; allocator noise stays well under half of it.
	const growth = batches.at(-1)!.rss - batches[0]!.rss;
	const printed = (BATCHES - 1) * COMMANDS * BYTES;
	assert.ok(
		growth < printed / 2,
		`resident memory grew by ${(growth / 1048576).toFixed(1)} MB over ${BATCHES - 1} ${what} whose commands printed ${(printed / 1048576).toFixed(0)} MB: ${batches.map((batch) => (batch.rss / 1048576).toFixed(0)).join(" ")}`,
	);
}
