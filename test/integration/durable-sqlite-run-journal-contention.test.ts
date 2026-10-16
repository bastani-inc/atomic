import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import {
	openSqlRunJournal,
	type SqlRunJournal,
} from "../../packages/workflows/src/durable/journal/sqlite-run-journal.js";
import { RUN_EVENT_TYPES as e, type JournalEntry } from "../../packages/workflows/src/durable/journal/types.js";
import { JournalTestDatabase } from "../helpers/journal-database.js";
import {
	bunExecutable,
	decodeStream,
	makeTempDirectory,
	readStreamText,
	removeTempDirectory,
	type SpawnedProcess,
	spawnProcess,
	spawnSyncCollect,
} from "../helpers/runtime.js";

const fixture = fileURLToPath(new URL("../fixtures/journal-process.mjs", import.meta.url));
const JOURNAL_PROCESS_TEST_TIMEOUT_MS = 120_000;
const header = { runId: "run", name: "workflow", cwd: "", createdAt: 0, status: "running" };

async function ready(child: SpawnedProcess, expected: string): Promise<ReadableStreamDefaultReader<string>> {
	assert.ok(child.stdout);
	const reader = decodeStream(child.stdout).getReader();
	let text = "";
	while (!text.includes("\n")) {
		const next = await reader.read();
		if (next.done) break;
		text += next.value;
	}
	assert.equal(text, `${expected}\n`);
	return reader;
}

async function remaining(reader: ReadableStreamDefaultReader<string>): Promise<string> {
	let text = "";
	for (;;) {
		const next = await reader.read();
		if (next.done) break;
		text += next.value;
	}
	reader.releaseLock();
	return text;
}

async function entries(journal: SqlRunJournal): Promise<JournalEntry[]> {
	const result: JournalEntry[] = [];
	for await (const entry of journal.read(header.runId)) result.push(entry);
	return result;
}

test(
	"SIGKILL during an open journal transaction leaves no partial write and preserves integrity",
	async () => {
		const directory = makeTempDirectory("journal-crash-");
		const path = join(directory, "journal.sqlite");
		const journal = await openSqlRunJournal(path);
		let child: SpawnedProcess | undefined;
		try {
			await journal.createRun(header);
			const lease = await journal.acquire(header.runId, "holder");
			assert.equal(lease.status, "acquired");
			if (lease.status !== "acquired") assert.fail("lease not acquired");
			const committed = await journal.append(lease.lease, { type: e.runStarted, payload: null });
			await journal.close();
			child = spawnProcess([process.execPath, fixture, "crash", path], { stdout: "pipe", stderr: "pipe" });
			const output = await ready(child, "transaction-open");
			child.kill("SIGKILL");
			assert.notEqual(await child.exited, 0);
			assert.equal(await remaining(output), "");
			const reopened = await openSqlRunJournal(path);
			try {
				assert.deepEqual(await entries(reopened), [committed.entry]);
				assert.equal((await reopened.listRuns())[0]?.status, "running");
				assert.equal(await reopened.readKey(header.runId, "partial"), undefined);
			} finally {
				await reopened.close();
			}
			const db = new JournalTestDatabase(path);
			try {
				assert.equal(db.get<{ integrity_check: string }>("PRAGMA integrity_check")?.integrity_check, "ok");
			} finally {
				db.close();
			}
		} finally {
			child?.kill("SIGKILL");
			await child?.exited;
			await journal.close();
			removeTempDirectory(directory);
		}
	},
	JOURNAL_PROCESS_TEST_TIMEOUT_MS,
);

test(
	"two Node children append 200 keyed events each under one lease without surfaced busy errors",
	async () => {
		const directory = makeTempDirectory("journal-contention-");
		const path = join(directory, "journal.sqlite");
		const journal = await openSqlRunJournal(path);
		const children: SpawnedProcess[] = [];
		try {
			await journal.createRun(header);
			const outcome = await journal.acquire(header.runId, "shared-holder");
			assert.equal(outcome.status, "acquired");
			if (outcome.status !== "acquired") assert.fail("lease not acquired");
			for (const prefix of ["first", "second"]) {
				children.push(
					spawnProcess(
						[process.execPath, fixture, "append", path, JSON.stringify({ lease: outcome.lease, prefix })],
						{ stdin: "pipe", stdout: "pipe", stderr: "pipe" },
					),
				);
			}
			const outputs = await Promise.all(children.map((child) => ready(child, "ready")));
			for (const child of children) child.stdin?.end("go\n");
			for (const [index, child] of children.entries()) {
				const stderr = readStreamText(child.stderr);
				const stdout = remaining(outputs[index] as ReadableStreamDefaultReader<string>);
				assert.equal(await child.exited, 0, await stderr);
				assert.equal(await stdout, "appended=200\n");
				assert.equal((await stderr).includes("SQLITE_BUSY"), false);
			}
			const persisted = await entries(journal);
			assert.equal(persisted.length, 400);
			assert.deepEqual(
				persisted.map((entry) => entry.seq),
				Array.from({ length: 400 }, (_, index) => index + 1),
			);
			assert.equal(new Set(persisted.map((entry) => entry.key)).size, 400);
			for (const prefix of ["first", "second"]) {
				for (let index = 0; index < 200; index++) {
					const entry = await journal.readKey(header.runId, `${prefix}:${index}`);
					assert.deepEqual(entry?.event, { type: e.summaryRecorded, payload: { prefix, index } });
					assert.equal(entry?.epoch, outcome.lease.epoch);
				}
			}
		} finally {
			for (const child of children) child.kill("SIGKILL");
			await Promise.all(children.map((child) => child.exited));
			await journal.close();
			removeTempDirectory(directory);
		}
	},
	JOURNAL_PROCESS_TEST_TIMEOUT_MS,
);

test(
	"a bunExecutable child opens, appends and reads the node:sqlite journal",
	async () => {
		const directory = makeTempDirectory("journal-bun-");
		try {
			const path = join(directory, "journal.sqlite");
			const result = spawnSyncCollect([bunExecutable(), fixture, "bun", path]);
			assert.equal(result.exitCode, 0, result.stderr.toString());
			assert.equal(result.stdout.toString(), "bun-open-append-read=ok\n");
			const journal = await openSqlRunJournal(path);
			try {
				assert.deepEqual((await journal.readKey("bun", ""))?.event, { type: e.runStarted, payload: ["bun", 0] });
			} finally {
				await journal.close();
			}
		} finally {
			removeTempDirectory(directory);
		}
	},
	JOURNAL_PROCESS_TEST_TIMEOUT_MS,
);

test(
	"Node and Bun reject invalid NUL/Unicode identifiers while preserving JSON NULs",
	async () => {
		const directory = makeTempDirectory("journal-nul-rejection-");
		const path = join(directory, "journal.sqlite");
		const journal = await openSqlRunJournal(path);
		try {
			const raw = {
				...header,
				runId: "prefix",
				inputs: { "input\u0000key": "é\u0000💡", "\u0000": "\u0000", "\ud800": "\ud800", "a\udfffb": "a\udfffb" },
			};
			await journal.createRun(raw);
			const acquired = await journal.acquire(raw.runId, "prefix");
			assert.equal(acquired.status, "acquired");
			if (acquired.status !== "acquired") assert.fail("lease not acquired");
			let lease = acquired.lease;
			for (const [index, executable] of [
				process.execPath,
				bunExecutable(),
				process.execPath,
				bunExecutable(),
			].entries()) {
				const nextHolder = `holder-${index}`;
				const key = `key-${index}`;
				const result = spawnSyncCollect([
					executable,
					fixture,
					"nul-rejection",
					path,
					JSON.stringify({ lease, nextHolder, key }),
				]);
				assert.equal(result.exitCode, 0, result.stderr.toString());
				assert.equal(result.stdout.toString(), "nul-rejection-json=ok\n");
				lease = { ...lease, holderId: nextHolder, epoch: lease.epoch + 1 };
				assert.deepEqual(await journal.acquire(raw.runId, nextHolder), { status: "acquired", lease });
				const reader = await openSqlRunJournal(path);
				try {
					assert.deepEqual(await reader.listRuns(), [raw]);
					const entry = await reader.readKey(raw.runId, key);
					assert.equal(entry?.runId, raw.runId);
					assert.equal(entry?.key, key);
					assert.equal(entry?.seq, index + 1);
					assert.equal(entry?.epoch, index + 1);
					assert.deepEqual(entry?.event, {
						type: e.summaryRecorded,
						payload: {
							"text\u0000key": "é\u0000💡",
							"\u0000": "\u0000",
							"\ud800": "\ud800",
							"a\udfffb": "a\udfffb",
						},
					});
				} finally {
					await reader.close();
				}
			}
		} finally {
			await journal.close();
			removeTempDirectory(directory);
		}
	},
	JOURNAL_PROCESS_TEST_TIMEOUT_MS,
);

test(
	"repeated Node and Bun processes preserve native rawJSON header inputs and payloads",
	async () => {
		const directory = makeTempDirectory("journal-raw-json-");
		const path = join(directory, "journal.sqlite");
		try {
			for (const [index, executable] of [
				process.execPath,
				bunExecutable(),
				process.execPath,
				bunExecutable(),
			].entries()) {
				const result = spawnSyncCollect([executable, fixture, "raw-json", path, `process-${index}`]);
				assert.equal(result.exitCode, 0, result.stderr.toString());
				assert.equal(result.stdout.toString(), "raw-json-lossless=ok\n");
			}
			const journal = await openSqlRunJournal(path);
			try {
				assert.equal((await journal.listRuns()).length, 16);
				for (let processIndex = 0; processIndex < 4; processIndex++) {
					for (const [index, text] of ["\ud800", "\udfff", "a\ud800b", "a\udfffb"].entries()) {
						const runId = `process-${processIndex}-${index}`;
						assert.equal((await journal.readKey(runId, "scalar"))?.event.payload, text);
						assert.deepEqual((await journal.readKey(runId, "nested"))?.event.payload, {
							rawJSON: text,
							[text]: [text, { nested: text }, "\u0000", text],
						});
					}
				}
			} finally {
				await journal.close();
			}
		} finally {
			removeTempDirectory(directory);
		}
	},
	JOURNAL_PROCESS_TEST_TIMEOUT_MS,
);
