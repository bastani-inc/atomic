/**
 * What the native task supervisor keeps in memory of finished shell commands (#4215).
 *
 * A child process runs batches of commands under the supervisor, each command printing 1 MB, and reports its
 * resident memory after each batch: one task owner (a session) per batch that closes after it, or one owner that stays
 * open for every batch, as a long-lived session does. A pipe command's output is spooled to a file, so it is freed as
 * soon as the command settles; a terminal (PTY) command's is in memory only, so it is freed when its session closes. A supervisor that kept every finished command's in-memory output
 * copies grew by about twice that output per batch, for as long as the process lived, in every Atomic process: an
 * interactive session running for hours, its workflow stages and subagents, and local workers. Its memory must stay
 * flat across batches, and each batch's first command must still read back its exact output.
 */
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { spawnSyncCollect } from "../helpers/runtime.js";

const fixture = fileURLToPath(new URL("../fixtures/native-command-output-retention.mjs", import.meta.url));
const BATCHES = 5;
const COMMANDS = 20;
const BYTES = 1_000_000;

interface Batch {
	readonly owner: number;
	readonly rss: number;
	readonly heapUsed: number;
	/** Null for terminal commands, whose output a terminal reformats. */
	readonly readBack: boolean | null;
}

function runBatches(open: boolean, pty = false): readonly Batch[] {
	const result = spawnSyncCollect([process.execPath, "--expose-gc", fixture], {
		env: {
			// Few malloc arenas: each command's reader threads can otherwise grow glibc's per-thread arenas by a few MB in
			// a step, which is allocator noise, not output the supervisor keeps.
			MALLOC_ARENA_MAX: "2",
			OWNERS: String(BATCHES),
			COMMANDS: String(COMMANDS),
			BYTES: String(BYTES),
			...(open ? { OPEN: "1" } : {}),
			...(pty ? { PTY: "1" } : {}),
		},
		timeout: 150_000,
	});
	assert.equal(result.exitCode, 0, result.stderr.toString());
	return result.stdout
		.toString()
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as Batch);
}

function assertFlat(batches: readonly Batch[], what: string): void {
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

test.runIf(process.platform !== "win32")(
	"a process's memory stays flat across closed sessions whose shell commands printed megabytes (#4215)",
	() => assertFlat(runBatches(false), "closed sessions"),
	180_000,
);

test.runIf(process.platform !== "win32")(
	"a process's memory stays flat across closed sessions whose terminal commands printed megabytes (#4215)",
	() => assertFlat(runBatches(false, true), "closed sessions"),
	180_000,
);

test.runIf(process.platform !== "win32")(
	"a long-lived session's memory stays flat while its shell commands print megabytes (#4215)",
	() => assertFlat(runBatches(true), "batches in one open session"),
	180_000,
);
