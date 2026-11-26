/**
 * A JSONL session file's epoch tells a writer the file is still the one it last saw (#4319). It stays the same
 * through appends and a clock that moves the file's times back, changes when the file is replaced, and an older
 * build's sidecars and diagnostics, written with the epoch that held the file's creation time, carry over.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, rename, stat, utimes, writeFile } from "node:fs/promises";
import { test } from "vitest";
import { SessionConflictError } from "../../packages/coding-agent/src/core/storage/session/errors.js";
import {
	appendFileChatRecord,
	readFileChatRecords,
} from "../../packages/coding-agent/src/core/storage/session/jsonl-chat-records.js";
import { JsonlSessionStore } from "../../packages/coding-agent/src/core/storage/session/jsonl-session-store.js";
import { SESSION_FORMAT_VERSION } from "../../packages/coding-agent/src/core/storage/session/types.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

const header = {
	id: "session",
	version: SESSION_FORMAT_VERSION,
	createdAt: "2026-11-26T00:00:00Z",
	cwd: "/project",
} as const;

function entry(id: string) {
	return { type: "session_info", id, parentId: null, timestamp: header.createdAt, name: id } as const;
}

const DAY_SECONDS = 86_400;

interface Sidecar {
	version: number;
	headerStamp: string;
	index: { epoch: string };
}

async function withDirectory(body: (directory: string) => Promise<void>): Promise<void> {
	const directory = makeTempDirectory("jsonl-epoch-");
	try {
		await body(directory);
	} finally {
		removeTempDirectory(directory);
	}
}

async function readSidecar(file: string): Promise<Sidecar> {
	const text = await readFile(`${file}.idx`, "utf8");
	return JSON.parse(text.slice(text.indexOf("\n") + 1)) as Sidecar;
}

/** The epoch every build before this one gave the file: its device, inode, creation time and header hash. */
async function olderBuildEpoch(file: string, headerStamp: string): Promise<string> {
	const stats = await stat(file, { bigint: true });
	const hash = createHash("sha256").update(headerStamp).digest("hex").slice(0, 16);
	return `${stats.dev}:${stats.ino}:${stats.birthtimeNs}:${hash}`;
}

/** Rewrites the file's sidecar as an older build writes it: version 2, with that build's epoch. */
async function writeOlderBuildSidecar(file: string): Promise<string> {
	const sidecar = await readSidecar(file);
	const epoch = await olderBuildEpoch(file, sidecar.headerStamp);
	const body = JSON.stringify({ ...sidecar, version: 2, index: { ...sidecar.index, epoch } });
	await writeFile(`${file}.idx`, `${createHash("sha256").update(body).digest("hex")}\n${body}`);
	return epoch;
}

async function sessionFile(directory: string): Promise<{ store: JsonlSessionStore; file: string; epoch: string }> {
	const store = await JsonlSessionStore.open(directory, { exactDirectory: true });
	const { epoch } = await store.create(header, [entry("a"), entry("b")]);
	assert.ok(epoch);
	const file = store.locationFor(header);
	// Reading a range indexes the file and writes its sidecar.
	await store.readRange(header.id, 1, 2, epoch);
	return { store, file, epoch };
}

test("a session file's clock jumping back keeps its epoch, so the next append and read go through (#4319)", async () => {
	await withDirectory(async (directory) => {
		const { store, file, epoch } = await sessionFile(directory);
		try {
			const now = Date.now() / 1000;
			await utimes(file, now - DAY_SECONDS, now - DAY_SECONDS);
			assert.deepEqual(await store.append(header.id, [entry("c")], { expectSeq: 2, epoch }), { lastSeq: 3 });
			const other = await JsonlSessionStore.open(directory, { exactDirectory: true });
			try {
				assert.equal((await other.readRange(header.id, 1, 3, epoch)).entries.length, 3);
				assert.deepEqual(await other.append(header.id, [entry("d")], { expectSeq: 3, epoch }), { lastSeq: 4 });
			} finally {
				await other.close();
			}
		} finally {
			await store.close();
		}
	});
});

test("a session file replaced by a copy of itself is still a conflict, its older sidecar beside it (#4319)", async () => {
	await withDirectory(async (directory) => {
		const { store, file, epoch } = await sessionFile(directory);
		await store.close();
		await writeOlderBuildSidecar(file);
		await writeFile(`${file}.copy`, await readFile(file));
		await rename(`${file}.copy`, file);
		const other = await JsonlSessionStore.open(directory, { exactDirectory: true });
		try {
			await assert.rejects(other.readRange(header.id, 1, 2, epoch), SessionConflictError);
			await assert.rejects(other.append(header.id, [entry("c")], { expectSeq: 2, epoch }), SessionConflictError);
			assert.equal((await readFile(file, "utf8")).split("\n").length, 4);
		} finally {
			await other.close();
		}
	});
});

test("an older build's sidecar is read without a conflict and rewritten with this build's epoch (#4319)", async () => {
	await withDirectory(async (directory) => {
		const { store, file, epoch } = await sessionFile(directory);
		await store.close();
		await writeOlderBuildSidecar(file);
		const upgraded = await JsonlSessionStore.open(directory, { exactDirectory: true });
		try {
			const range = await upgraded.readRange(header.id, 1, 2, epoch);
			assert.equal(range.epoch, epoch);
			assert.deepEqual(
				range.entries.map(({ id }) => id),
				["a", "b"],
			);
			assert.equal((await upgraded.readEntrySizes(header.id, 1, 2)).epoch, epoch);
			assert.equal((await readSidecar(file)).index.epoch, epoch);
			assert.deepEqual(await upgraded.append(header.id, [entry("c")], { expectSeq: 2, epoch }), { lastSeq: 3 });
		} finally {
			await upgraded.close();
		}
	});
});

test("this build and an older one writing the same session read each other's appends and diagnostics (#4319)", async () => {
	await withDirectory(async (directory) => {
		const { store, file, epoch } = await sessionFile(directory);
		const older = await JsonlSessionStore.open(directory, { exactDirectory: true });
		try {
			// The older build appends and leaves its sidecar and a diagnostic under its own epoch.
			await older.append(header.id, [entry("c")], { expectSeq: 2 });
			await older.readRange(header.id, 1, 3);
			const olderEpoch = await writeOlderBuildSidecar(file);
			await appendFileChatRecord({ id: header.id, file, epoch: olderEpoch }, "c", {
				kind: "line",
				level: "warning",
				text: "from the older build",
			});
			assert.deepEqual(await store.append(header.id, [entry("d")], { expectSeq: 3, epoch }), { lastSeq: 4 });
			const reader = await JsonlSessionStore.open(directory, { exactDirectory: true });
			try {
				const range = await reader.readRange(header.id, 1, 4, epoch);
				assert.deepEqual(
					range.entries.map(({ id }) => id),
					["a", "b", "c", "d"],
				);
			} finally {
				await reader.close();
			}
			const records = await readFileChatRecords({ id: header.id, file, epoch }, ["c"]);
			assert.deepEqual(
				records.map(({ record }) => (record.kind === "line" ? record.text : record.kind)),
				["from the older build"],
			);
			// An older build reads only a version 2 sidecar, so one holding any other epoch has another version.
			const written = await readSidecar(file);
			assert.ok(
				written.version !== 2 || written.index.epoch === (await olderBuildEpoch(file, written.headerStamp)),
				JSON.stringify({ version: written.version, epoch: written.index.epoch }),
			);
		} finally {
			await older.close();
			await store.close();
		}
	});
});
