/**
 * Chaos for the JSONL session store's header reads and a new session's batched start state (#4319): writer processes
 * killed or stopped mid-write, many writers sharing one directory, a full disk, and skewed file clocks. Every session
 * that survives keeps a header that reads back whole, however long, and its model and thinking level stay together.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { type SessionEntry, SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { JsonlSessionStore } from "../../packages/coding-agent/src/core/storage/session/jsonl-session-store.js";
import { createProcessSuspender } from "../helpers/process-suspension.js";
import { bunExecutable, readStreamText, type SpawnedProcess, sleep, spawnProcess } from "../helpers/runtime.js";

const WRITER = fileURLToPath(new URL("../fixtures/jsonl-session-chaos-writer.ts", import.meta.url));
/** Structural cost: every case spawns several Bun processes that load the session store from source. */
const CHAOS_TEST_TIMEOUT_MS = 120_000;
/** A cwd of this many two-byte characters makes a header longer than two 64 KiB header reads. */
const MULTI_READ_CWD_CHARACTERS = 70_000;
/** A directory on a small filesystem the disk-full case may fill, such as a 2 MiB tmpfs; that case needs one. */
const SMALL_FILESYSTEM = process.env.ATOMIC_CHAOS_SMALL_FS_DIR;

function cwdOf(tag: string, characters: number): string {
	return resolve(`/${tag}/${"é".repeat(characters)}`);
}

function writer(directory: string, tag: string, cwdCharacters: number, sessions?: number): SpawnedProcess {
	return spawnProcess(
		[
			bunExecutable(),
			WRITER,
			directory,
			tag,
			String(cwdCharacters),
			...(sessions === undefined ? [] : [String(sessions)]),
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
}

async function stopWriters(writers: readonly SpawnedProcess[]): Promise<void> {
	for (const child of writers) {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	}
	await Promise.all(writers.map((child) => child.exited));
}

const pendingOutput = new WeakMap<SpawnedProcess, string>();

/** The writer's next line of output; output that arrived with an earlier line waits for the next call. */
async function readLine(child: SpawnedProcess): Promise<string> {
	assert.ok(child.stdout);
	let text = pendingOutput.get(child) ?? "";
	const reader = child.stdout.getReader();
	try {
		while (!text.includes("\n")) {
			const next = await reader.read();
			if (next.done) assert.fail(`writer exited: ${await readStreamText(child.stderr)}`);
			text += new TextDecoder().decode(next.value);
		}
	} finally {
		reader.releaseLock();
	}
	const newline = text.indexOf("\n");
	pendingOutput.set(child, text.slice(newline + 1));
	return text.slice(0, newline).trim();
}

/** A new session's first entries are its model and thinking level together, and every entry follows the one before. */
function assertStartStateTogether(entries: readonly SessionEntry[], tag: string, location: string): void {
	if (entries.length === 0) return;
	const [model, thinking] = entries;
	assert.equal(model?.type, "model_change", location);
	assert.equal(model.type === "model_change" ? model.modelId : undefined, tag, location);
	assert.equal(thinking?.type, "thinking_level_change", `${location}: its thinking level was written with its model`);
	let parentId: string | null = null;
	for (const entry of entries) {
		assert.equal(entry.parentId, parentId, location);
		parentId = entry.id;
	}
}

/**
 * Every session file in `directory` reads back: its header whole, from one of `tags`, and its start state together.
 * Returns how many sessions each tag left.
 */
async function assertSessionsIntact(
	directory: string,
	tags: readonly string[],
	cwdCharacters: number,
): Promise<Map<string, number>> {
	const files = readdirSync(directory).filter((name) => name.endsWith(".jsonl"));
	const store = await JsonlSessionStore.open(directory, { exactDirectory: true, scanExisting: false });
	const counts = new Map<string, number>();
	try {
		let scanned = 0;
		for await (const file of store.scanFiles()) {
			scanned++;
			const tag = tags.find((candidate) => file.header.cwd === cwdOf(candidate, cwdCharacters));
			assert.ok(tag, `${file.location}: header cwd of ${file.header.cwd.length} characters is no writer's`);
			const snapshot = await file.read();
			assert.equal(snapshot.header.id, file.header.id);
			assertStartStateTogether(snapshot.entries, tag, file.location);
			counts.set(tag, (counts.get(tag) ?? 0) + 1);
		}
		assert.equal(scanned, files.length, "every session file's header reads");
	} finally {
		await store.close();
	}
	return counts;
}

function scratchDirectory(prefix: string, parent = tmpdir()): string {
	return mkdtempSync(join(parent, prefix));
}

test(
	"writers SIGKILLed mid-write leave every session readable, its start state whole (#4319)",
	async () => {
		const directory = scratchDirectory("jsonl-chaos-kill-");
		const writers: SpawnedProcess[] = [];
		try {
			// One directory per writer: a writer killed holding its directory's lock leaves it for the next round's
			// writer to take over once stale, without several takers racing for one stale lock.
			const tags = ["k0", "k1", "k2", "k3"];
			for (const tag of tags) mkdirSync(join(directory, tag));
			for (let round = 0; round < 3; round++) {
				const roundWriters = tags.map((tag) => writer(join(directory, tag), tag, 300));
				writers.push(...roundWriters);
				for (const child of roundWriters) assert.equal(await readLine(child), "ready");
				await sleep(50 + round * 70);
				for (const child of roundWriters) child.kill("SIGKILL");
				for (const child of roundWriters) await child.exited;
				assert.ok(roundWriters.every((child) => child.signalCode === "SIGKILL"));
			}
			for (const tag of tags) {
				const counts = await assertSessionsIntact(join(directory, tag), [tag], 300);
				assert.ok((counts.get(tag) ?? 0) >= 3, `${tag} wrote sessions in every round`);
			}
		} finally {
			await stopWriters(writers);
			rmSync(directory, { recursive: true, force: true });
		}
	},
	CHAOS_TEST_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32")(
	"a writer SIGSTOPped mid-write never blocks reading the directory's headers, and finishes once continued (#4319)",
	async () => {
		const directory = scratchDirectory("jsonl-chaos-stop-");
		const writers: SpawnedProcess[] = [];
		const suspender = await createProcessSuspender();
		try {
			const child = writer(directory, "stopped", 300, 40);
			writers.push(child);
			assert.equal(await readLine(child), "ready");
			const pid = child.pid;
			assert.ok(pid !== undefined);
			for (let pause = 0; pause < 5; pause++) {
				await suspender.suspend(pid);
				await assertSessionsIntact(directory, ["stopped"], 300);
				await suspender.resume(pid);
				await sleep(20);
			}
			assert.match(await readLine(child), /^done 40$/);
			assert.equal(await child.exited, 0, await readStreamText(child.stderr));
			assert.equal((await assertSessionsIntact(directory, ["stopped"], 300)).get("stopped"), 40);
		} finally {
			await stopWriters(writers);
			await suspender.close();
			rmSync(directory, { recursive: true, force: true });
		}
	},
	CHAOS_TEST_TIMEOUT_MS,
);

test(
	"many writers sharing a directory each read back their own multi-read headers while readers scan it (#4319)",
	async () => {
		const directory = scratchDirectory("jsonl-chaos-many-");
		const writers: SpawnedProcess[] = [];
		try {
			const tags = Array.from({ length: 16 }, (_, index) => `w${index}`);
			writers.push(...tags.map((tag) => writer(directory, tag, MULTI_READ_CWD_CHARACTERS, 6)));
			const settled = Promise.all(writers.map((child) => child.exited));
			let scans = 0;
			for (let done = false; !done; ) {
				done = await Promise.race([settled.then(() => true), sleep(25).then(() => false)]);
				const store = await JsonlSessionStore.open(directory, { exactDirectory: true, scanExisting: false });
				try {
					for await (const file of store.scanFiles()) {
						assert.ok(
							tags.some((tag) => file.header.cwd === cwdOf(tag, MULTI_READ_CWD_CHARACTERS)),
							`${file.location}: a header read back torn or mixed`,
						);
					}
				} finally {
					await store.close();
				}
				scans++;
			}
			for (const child of writers) assert.equal(child.exitCode, 0, await readStreamText(child.stderr));
			assert.ok(scans > 1, "readers scanned while the writers wrote");
			const counts = await assertSessionsIntact(directory, tags, MULTI_READ_CWD_CHARACTERS);
			for (const tag of tags) assert.equal(counts.get(tag), 6, tag);
		} finally {
			await stopWriters(writers);
			rmSync(directory, { recursive: true, force: true });
		}
	},
	CHAOS_TEST_TIMEOUT_MS,
);

test.skipIf(SMALL_FILESYSTEM === undefined)(
	"writers that fill the disk leave every session readable, its start state whole (#4319)",
	async () => {
		const directory = scratchDirectory("jsonl-chaos-full-", SMALL_FILESYSTEM);
		const writers: SpawnedProcess[] = [];
		try {
			const tags = ["f0", "f1", "f2", "f3"];
			writers.push(...tags.map((tag) => writer(directory, tag, 2_000)));
			const finals = await Promise.all(
				writers.map(async (child) => {
					const first = await readLine(child);
					const last = first === "ready" ? await readLine(child) : first;
					assert.equal(await child.exited, 0, await readStreamText(child.stderr));
					return last;
				}),
			);
			assert.ok(
				finals.every((line) => line.startsWith("full ")),
				`every writer ran out of space: ${finals.join(", ")}`,
			);
			await assertSessionsIntact(directory, tags, 2_000);
		} finally {
			await stopWriters(writers);
			rmSync(directory, { recursive: true, force: true });
		}
	},
	CHAOS_TEST_TIMEOUT_MS,
);

test("appends and header reads hold when the session file's clock jumps forward or back (#4319)", async () => {
	const directory = scratchDirectory("jsonl-chaos-clock-");
	try {
		const cwd = cwdOf("clock", MULTI_READ_CWD_CHARACTERS);
		const manager = await SessionManager.create(cwd, directory);
		await manager.appendStartState({ provider: "chaos", modelId: "clock" }, "high");
		const file = manager.getSessionFile();
		assert.ok(file);
		const now = Date.now() / 1000;
		for (const skew of [86_400, -86_400, 0, -3_600 * 24 * 365]) {
			utimesSync(file, now + skew, now + skew);
			await manager.appendMessage({ role: "user", content: `skew ${skew}`, timestamp: Date.now() });
			assert.equal(statSync(file).isFile(), true);
		}
		const counts = await assertSessionsIntact(directory, ["clock"], MULTI_READ_CWD_CHARACTERS);
		assert.equal(counts.get("clock"), 1);
		const store = await JsonlSessionStore.open(directory, { exactDirectory: true });
		try {
			const snapshot = await store.load(manager.getSessionId());
			assert.equal(snapshot.header.cwd, cwd);
			assert.equal(snapshot.lastSeq, 6);
		} finally {
			await store.close();
		}
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
