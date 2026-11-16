import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { readStreamText, spawnProcess } from "../helpers/runtime.js";

const fixture = fileURLToPath(new URL("../fixtures/storage-libsql-close-once.mjs", import.meta.url));
const wrapperFixture = fileURLToPath(new URL("../fixtures/storage-libsql-wrapper-close-once.mjs", import.meta.url));

/**
 * glibc's allocator, told to fill memory it frees with 0xba (SQLite's "sick connection" marker) and to keep no
 * per-thread cache that would skip the fill, turns a second `sqlite3_close_v2` of a freed connection into a certain
 * segmentation fault: the call takes the connection for a sick one and locks the mutex its freed memory names. Windows
 * crashes the same way, without a message, once its heap reuses the freed block. Other C libraries ignore these
 * variables, and the process then runs as it normally does.
 */
const FREED_MEMORY_POISON = { GLIBC_TUNABLES: "glibc.malloc.tcache_count=0", MALLOC_PERTURB_: String(0xba) };

const CHILD_PROCESS_TIMEOUT_MS = 60_000;

async function runPoisoned(args: readonly string[]): Promise<void> {
	const child = spawnProcess([process.execPath, ...args], {
		env: { ...process.env, ...FREED_MEMORY_POISON },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		readStreamText(child.stdout),
		readStreamText(child.stderr),
		child.exited,
	]);
	assert.deepEqual({ code, signal: child.signalCode, stdout }, { code: 0, signal: null, stdout: "closed\n" }, stderr);
}

test(
	"closing two libSQL file databases a process opens over one file closes each connection once",
	async () => {
		await runPoisoned([fixture]);
	},
	CHILD_PROCESS_TIMEOUT_MS,
);

test(
	"closing libSQL file databases the documented custom driver opens closes each connection once (#5325)",
	async () => {
		await runPoisoned(["--expose-gc", wrapperFixture]);
	},
	CHILD_PROCESS_TIMEOUT_MS,
);
