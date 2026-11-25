import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import type { SerializedStorageError } from "../../packages/coding-agent/src/core/storage/errors.js";
import type { WriterQueueStats } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import {
	makeTempDirectory,
	readStreamText,
	removeTempDirectory,
	type SpawnedProcess,
	sleep,
	spawnProcess,
} from "../helpers/runtime.js";

const WRITER = fileURLToPath(new URL("../fixtures/sqlite-queue-writer.mjs", import.meta.url));
const HOLDER = fileURLToPath(new URL("../fixtures/sqlite-stalling-holder.mjs", import.meta.url));
/** Child processes, jiti-loaded adapters, and waits of a few ticket lifetimes (2 s each). */
export const CHAOS_TEST_TIMEOUT_MS = 120_000;

export interface WriterOptions {
	readonly label: string;
	readonly transactions?: number;
	readonly concurrency?: number;
	readonly busyMs?: number;
	readonly lockWaitMs?: number;
	readonly clockSkewMs?: number;
	readonly blobBytes?: number;
	readonly fillDatabase?: boolean;
}

export interface WriterReport {
	readonly pid: number;
	readonly label: string;
	readonly committed: number;
	readonly errors: SerializedStorageError[];
	readonly stats: WriterQueueStats;
}

export interface StartedWriter {
	readonly child: SpawnedProcess;
	readonly pid: number;
	readonly go: () => void;
	readonly report: () => Promise<WriterReport>;
}

export interface StartedHolder {
	readonly child: SpawnedProcess;
	readonly pid: number;
	readonly commit: () => Promise<void>;
}

export interface WriterQueueChaosHarness {
	readonly database: (prefix: string) => { readonly path: string; readonly writers: string };
	readonly startWriter: (path: string, options: WriterOptions) => Promise<StartedWriter>;
	readonly startHolder: (path: string) => Promise<StartedHolder>;
	readonly cleanup: () => Promise<void>;
}

/** Reads a child's stdout line by line, keeping what arrives after a line for the next read. */
class Lines {
	private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
	private buffered = "";
	private readonly child: SpawnedProcess;

	constructor(child: SpawnedProcess) {
		assert.ok(child.stdout);
		this.child = child;
		this.reader = child.stdout.getReader();
	}

	async next(): Promise<string> {
		while (!this.buffered.includes("\n")) {
			const chunk = await this.reader.read();
			if (chunk.done) assert.fail(`child exited: ${await readStreamText(this.child.stderr)}`);
			this.buffered += new TextDecoder().decode(chunk.value);
		}
		const end = this.buffered.indexOf("\n");
		const line = this.buffered.slice(0, end);
		this.buffered = this.buffered.slice(end + 1);
		return line;
	}
}

export function createWriterQueueChaosHarness(): WriterQueueChaosHarness {
	const children: SpawnedProcess[] = [];
	const directories: string[] = [];

	const cleanup = async (): Promise<void> => {
		try {
			for (const child of children.splice(0)) {
				if (process.platform !== "win32") child.kill("SIGCONT");
				child.kill("SIGKILL");
				await child.exited;
			}
		} finally {
			for (const directory of directories.splice(0)) removeTempDirectory(directory);
		}
	};

	const database = (prefix: string): { readonly path: string; readonly writers: string } => {
		const directory = makeTempDirectory(prefix);
		directories.push(directory);
		const path = join(directory, "journal.sqlite");
		const setup = new DatabaseSync(path);
		setup.exec(
			"PRAGMA journal_mode = WAL; CREATE TABLE writes(writer TEXT NOT NULL, seq INTEGER NOT NULL, payload BLOB)",
		);
		setup.close();
		return { path, writers: `${path}-writers` };
	};

	const startWriter = async (path: string, options: WriterOptions): Promise<StartedWriter> => {
		const child = spawnProcess([process.execPath, WRITER, path, JSON.stringify(options)], {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		children.push(child);
		const lines = new Lines(child);
		assert.equal(await lines.next(), "ready");
		return {
			child,
			pid: child.pid!,
			go: () => {
				child.stdin?.end("go\n");
			},
			report: async () => JSON.parse(await lines.next()) as WriterReport,
		};
	};

	/** An Atomic process holding the write lock mid-transaction, with one uncommitted row; `commit` lets it finish. */
	const startHolder = async (path: string): Promise<StartedHolder> => {
		const child = spawnProcess([process.execPath, HOLDER, path, "stdin"], {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		children.push(child);
		const lines = new Lines(child);
		assert.equal(await lines.next(), "locked");
		return {
			child,
			pid: child.pid!,
			async commit() {
				child.stdin?.end("commit\n");
				assert.equal(await lines.next(), "committed");
				assert.equal(await child.exited, 0, await readStreamText(child.stderr));
			},
		};
	};

	return { database, startWriter, startHolder, cleanup };
}

export function ticketsOf(writers: string, pid: number): string[] {
	return existsSync(writers) ? readdirSync(writers).filter((name) => name.split("-")[1] === String(pid)) : [];
}

/** Waits until the process has a ticket in the writers' queue: it is waiting for the lock. */
export async function untilQueued(writers: string, pid: number): Promise<string> {
	for (;;) {
		const [ticket] = ticketsOf(writers, pid);
		if (ticket !== undefined) return ticket;
		await sleep(5);
	}
}

/** A reader that waits out a writer process still closing (its last checkpoint locks the file briefly). */
export function readerOf(path: string): DatabaseSync {
	return new DatabaseSync(path, { readOnly: true, timeout: 10_000 });
}

export function rows(path: string): { writer: string; seq: number }[] {
	const reader = readerOf(path);
	try {
		return reader.prepare("SELECT writer, seq FROM writes ORDER BY rowid").all() as { writer: string; seq: number }[];
	} finally {
		reader.close();
	}
}

export function assertIntact(path: string): void {
	const reader = readerOf(path);
	try {
		assert.deepEqual(
			reader
				.prepare("PRAGMA integrity_check")
				.all()
				.map((row) => row.integrity_check),
			["ok"],
		);
	} finally {
		reader.close();
	}
}
