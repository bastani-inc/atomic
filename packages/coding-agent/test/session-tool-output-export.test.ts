/**
 * An exported session carries the tool outputs its released stages kept as session blobs, inline, so the file restores
 * them into another store; an import checks each against its hash before writing anything (#4379).
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	chmodSync,
	closeSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/pi-ai/compat";
import { afterEach, test, vi } from "vitest";
import { useTemporaryAgentDir } from "../../../test/helpers/temporary-agent-dir.js";
import { getAgentDir } from "../src/config.js";
import type { CustomEntry } from "../src/core/session-manager.js";
import { getDefaultSessionDirPath, SessionManager } from "../src/core/session-manager.js";
import {
	sessionBlobOutput,
	TOOL_OUTPUT_ENTRY_TYPE,
	type ToolOutputReference,
} from "../src/core/session-tool-output.js";
import { isSessionBlobError } from "../src/core/storage/errors.js";
import { openNodeSqliteDatabase } from "../src/core/storage/node-sqlite.js";
import { JsonlSessionStore } from "../src/core/storage/session/jsonl-session-store.js";
import { SqlSessionStore } from "../src/core/storage/session/sql-session-store.js";
import { createHarness, getMessageText, type Harness } from "./suite/harness.js";

useTemporaryAgentDir();

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		writeSync: vi.fn(actual.writeSync),
		openSync: vi.fn(actual.openSync),
		closeSync: vi.fn(actual.closeSync),
		rmSync: vi.fn(actual.rmSync),
	};
});

const directories: string[] = [];
const closers: (() => Promise<void>)[] = [];
const harnesses: Harness[] = [];
afterEach(async () => {
	while (harnesses.length > 0) await harnesses.pop()?.cleanup();
	while (closers.length > 0) await closers.pop()?.();
	while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true });
});

function temporaryDirectory(prefix: string): string {
	const directory = mkdtempSync(join(tmpdir(), prefix));
	directories.push(directory);
	return directory;
}

async function sqlStore(directory: string, name: string): Promise<SqlSessionStore> {
	const database = await openNodeSqliteDatabase(join(directory, `${name}.sqlite`));
	const store = await SqlSessionStore.open(database);
	closers.push(async () => {
		await store.close();
		await database.close();
	});
	return store;
}

const OUTPUT = `BEGIN\n${"exported output ".repeat(8192)}\nEND`;
const HASH = createHash("sha256").update(OUTPUT, "utf8").digest("hex");

/** A session in its own database whose released stage kept `OUTPUT` as a blob, exported to a file. */
async function exported(directory: string, options?: { readonly toolOutputContent?: boolean }) {
	const store = await sqlStore(directory, "source");
	const manager = await SessionManager.create(store, process.cwd());
	const harness = await createHarness({ sessionManager: manager });
	harnesses.push(harness);
	await manager.appendMessage({ role: "user", content: "run the report", timestamp: Date.now() });
	const kept = await sessionBlobOutput(manager, "call-1")!(OUTPUT);
	assert.equal(kept.location, `tool-output://${HASH}`);
	const path = await harness.session.exportToJsonl(join(directory, "export.jsonl"), options);
	return { path, sessionId: manager.getSessionId(), harness };
}

function references(lines: readonly string[]): ToolOutputReference[] {
	return lines
		.map((line) => JSON.parse(line) as CustomEntry<ToolOutputReference>)
		.flatMap((entry) => (entry.type === "custom" && entry.customType === "atomic.tool-output" ? [entry.data!] : []));
}

function fileLines(path: string): string[] {
	return readFileSync(path, "utf8").trim().split("\n");
}

test("an export carries the blob inline and an import into another database restores it (#4379)", async () => {
	const directory = temporaryDirectory("atomic-tool-output-export-");
	const { path, sessionId } = await exported(directory);
	assert.deepEqual(references(fileLines(path)), [
		{
			toolCallId: "call-1",
			hash: HASH,
			bytes: Buffer.byteLength(OUTPUT),
			base64: Buffer.from(OUTPUT).toString("base64"),
		},
	]);
	const target = await sqlStore(directory, "target");

	const imported = await SessionManager.importFromJsonl(path, process.cwd(), target);

	assert.equal(imported.getSessionId(), sessionId);
	assert.equal(Buffer.from((await target.getBlob(sessionId, HASH))!).toString("utf8"), OUTPUT);
	const stored = (await target.load(sessionId)).entries.flatMap((entry) =>
		entry.type === "custom" && entry.customType === TOOL_OUTPUT_ENTRY_TYPE ? [entry.data] : [],
	);
	assert.deepEqual(stored, [{ toolCallId: "call-1", hash: HASH, bytes: Buffer.byteLength(OUTPUT) }]);
});

test("an export for sharing leaves the blob out and keeps the reference (#4379)", async () => {
	const directory = temporaryDirectory("atomic-tool-output-share-");

	const { path } = await exported(directory, { toolOutputContent: false });

	assert.deepEqual(references(fileLines(path)), [
		{ toolCallId: "call-1", hash: HASH, bytes: Buffer.byteLength(OUTPUT) },
	]);
});

test("an import whose inline output does not match its hash is blob-corrupt and writes nothing (#4379)", async () => {
	const directory = temporaryDirectory("atomic-tool-output-corrupt-");
	const { path, sessionId } = await exported(directory);
	const tampered = fileLines(path).map((line) => {
		const entry = JSON.parse(line) as CustomEntry<ToolOutputReference>;
		if (entry.type !== "custom" || entry.customType !== TOOL_OUTPUT_ENTRY_TYPE) return line;
		return JSON.stringify({
			...entry,
			data: { ...entry.data, base64: Buffer.from(`${OUTPUT}!`).toString("base64") },
		});
	});
	writeFileSync(path, `${tampered.join("\n")}\n`);
	const target = await sqlStore(directory, "target");

	await assert.rejects(SessionManager.importFromJsonl(path, process.cwd(), target), (error) => {
		assert.ok(isSessionBlobError(error));
		assert.equal(error.code, "blob-corrupt");
		assert.equal(error.sessionId, sessionId);
		assert.equal(error.hash, HASH);
		return true;
	});

	assert.equal(await target.readHeader(sessionId), undefined);
});

test("an import into a session directory, which holds no blobs, is blobs-unsupported and writes nothing (#4379)", async () => {
	const directory = temporaryDirectory("atomic-tool-output-jsonl-import-");
	const { path } = await exported(directory);
	const sessionDir = join(directory, "sessions");
	const creates = vi.spyOn(JsonlSessionStore.prototype, "create");

	await assert.rejects(SessionManager.importFromJsonl(path, process.cwd(), sessionDir), (error) => {
		assert.ok(isSessionBlobError(error));
		assert.equal(error.code, "blobs-unsupported");
		assert.equal(error.adapter, "jsonl");
		return true;
	});

	assert.equal(creates.mock.calls.length, 0, "no session was created");
	assert.ok(!existsSync(sessionDir) || readdirSync(sessionDir).length === 0, "no session file was written");
	creates.mockRestore();
});

test("forking an exported file stores its tool outputs with the fork in the target store (#4379)", async () => {
	const directory = temporaryDirectory("atomic-tool-output-fork-file-");
	const { path } = await exported(directory);

	const forked = await SessionManager.forkFrom(path, process.cwd());
	const store = forked.getSessionStore();
	closers.push(() => store.close());

	assert.equal(Buffer.from((await store.getBlob!(forked.getSessionId(), HASH))!).toString("utf8"), OUTPUT);
	assert.deepEqual(
		forked
			.getEntries()
			.flatMap((entry) =>
				entry.type === "custom" && entry.customType === TOOL_OUTPUT_ENTRY_TYPE ? [entry.data] : [],
			),
		[{ toolCallId: "call-1", hash: HASH, bytes: Buffer.byteLength(OUTPUT) }],
	);
});

test("forking an exported file is checked before anything is created: a session directory, or a tampered file (#4379)", async () => {
	const directory = temporaryDirectory("atomic-tool-output-fork-refused-");
	const { path } = await exported(directory);
	const creates = vi.spyOn(JsonlSessionStore.prototype, "create");

	await assert.rejects(SessionManager.forkFrom(path, process.cwd(), join(directory, "forks")), (error) => {
		assert.ok(isSessionBlobError(error));
		assert.equal(error.code, "blobs-unsupported");
		return true;
	});
	writeFileSync(
		path,
		readFileSync(path, "utf8").replace(Buffer.from(OUTPUT).toString("base64"), Buffer.from("x").toString("base64")),
	);
	await assert.rejects(SessionManager.forkFrom(path, process.cwd(), join(directory, "forks")), (error) => {
		assert.ok(isSessionBlobError(error));
		assert.equal(error.code, "blob-corrupt");
		assert.equal(error.hash, HASH);
		return true;
	});

	assert.equal(creates.mock.calls.length, 0, "no session was created");
	creates.mockRestore();
});

test("a persisted session reads its tool output and its artifacts through one resource router (#4379)", async () => {
	const directory = temporaryDirectory("atomic-tool-output-router-");
	const { harness } = await exported(directory);
	const artifacts = join(getDefaultSessionDirPath(harness.sessionManager.getCwd(), getAgentDir()), "artifacts");
	mkdirSync(artifacts, { recursive: true });
	writeFileSync(join(artifacts, "0.note.log"), "an artifact line\n");
	harness.setResponses([
		fauxAssistantMessage(
			[
				fauxToolCall("read", { path: `tool-output://${HASH}:1-1:raw` }, { id: "read-output" }),
				fauxToolCall("read", { path: "artifact://0" }, { id: "read-artifact" }),
			],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("done"),
	]);

	await harness.session.prompt("read both");

	const results = new Map(
		harness.sessionManager
			.buildSessionProjection()
			.messages.flatMap((message) =>
				message.role === "toolResult" ? [[message.toolCallId, message] as const] : [],
			),
	);
	const output = results.get("read-output");
	const artifact = results.get("read-artifact");
	assert.ok(output && artifact);
	assert.equal(output.isError, false, getMessageText(output));
	assert.match(getMessageText(output), /^BEGIN\b/);
	assert.equal(artifact.isError, false, getMessageText(artifact));
	assert.match(getMessageText(artifact), /an artifact line/);
});

/** A session in its own database whose released stages kept one blob each, ready to export. */
async function sessionWithOutputs(directory: string, count: number) {
	const store = await sqlStore(directory, "source");
	const manager = await SessionManager.create(store, process.cwd());
	const harness = await createHarness({ sessionManager: manager });
	harnesses.push(harness);
	await manager.appendMessage({ role: "user", content: "run the reports", timestamp: Date.now() });
	const hashes: string[] = [];
	for (let index = 0; index < count; index++) {
		const kept = await sessionBlobOutput(manager, `call-${index}`)!(`output ${index}\n${"x".repeat(5000)}`);
		hashes.push(kept.sha256);
	}
	return { store, manager, harness, hashes };
}

test("an export carries the outputs of the session it was started for, even when the manager moves on while it waits (#4379)", async () => {
	const directory = temporaryDirectory("atomic-tool-output-export-moved-");
	const { manager, harness } = await sessionWithOutputs(directory, 1);
	let moved = false;
	const sessionId = manager.getSessionId();
	vi.spyOn(manager, "getSessionId").mockImplementation(() => (moved ? "another-session" : sessionId));
	const getEntries = manager.getEntries.bind(manager);
	// The export collects the session's entries just before it waits on the snapshot content.
	vi.spyOn(manager, "getEntries").mockImplementation(() => {
		moved = true;
		return getEntries();
	});

	const path = await harness.session.exportToJsonl(join(directory, "export.jsonl"));

	assert.equal(moved, true);
	const [carried] = references(fileLines(path));
	assert.equal(typeof carried?.base64, "string", "the output of the exported session is in the file");
});

test("an export holds one carried output at a time, writing each entry before it reads the next output (#4379)", async () => {
	const directory = temporaryDirectory("atomic-tool-output-export-stream-");
	const { store, harness } = await sessionWithOutputs(directory, 3);
	const events: string[] = [];
	const getBlob = store.getBlob.bind(store);
	store.getBlob = async (sessionId, hash) => {
		events.push("read");
		return getBlob(sessionId, hash);
	};
	const actualWrite = (await vi.importActual<typeof import("node:fs")>("node:fs")).writeSync;
	vi.mocked(writeSync).mockImplementation(((...args: Parameters<typeof actualWrite>) => {
		events.push("write");
		return actualWrite(...args);
	}) as never);
	let path: string;
	try {
		path = await harness.session.exportToJsonl(join(directory, "export.jsonl"));
	} finally {
		vi.mocked(writeSync).mockImplementation(actualWrite as never);
	}

	assert.equal(references(fileLines(path)).filter((reference) => reference.base64 !== undefined).length, 3);
	assert.equal(events.filter((event) => event === "read").length, 3);
	assert.ok(
		!events.some((event, index) => event === "read" && events[index + 1] === "read"),
		`two outputs were read in a row: ${events.join(" ")}`,
	);
});

test("an export that fails part way leaves the file it was to replace as it was, and no partial file (#4379)", async () => {
	const directory = temporaryDirectory("atomic-tool-output-export-failed-");
	const { store, harness } = await sessionWithOutputs(directory, 3);
	const target = join(directory, "export.jsonl");
	writeFileSync(target, "previous export");
	const failure = new Error("disk read failed");
	const getBlob = store.getBlob.bind(store);
	let reads = 0;
	store.getBlob = async (sessionId, hash) => {
		if (++reads === 2) throw failure;
		return getBlob(sessionId, hash);
	};

	await assert.rejects(harness.session.exportToJsonl(target), (error) => error === failure);

	assert.equal(readFileSync(target, "utf8"), "previous export");
	assert.deepEqual(
		readdirSync(directory).filter((name) => name.endsWith(".partial")),
		[],
	);
});

test("an export for sharing ends with the share context, chained to the last entry (#4379)", async () => {
	const directory = temporaryDirectory("atomic-tool-output-export-share-");
	const { harness } = await sessionWithOutputs(directory, 1);

	const path = await harness.session.exportToJsonl(join(directory, "export.jsonl"), { includeShareContext: true });

	const entries = fileLines(path).map(
		(line) =>
			JSON.parse(line) as { type: string; id: string; parentId: string | null; customType?: string; data?: unknown },
	);
	const share = entries.at(-1);
	assert.equal(share?.type, "custom");
	assert.equal(share?.customType, "atomic.share");
	assert.equal(share?.parentId, entries.at(-2)?.id);
	const data = share?.data as { systemPrompt: string; tools: { name: string; parameters: unknown }[] };
	assert.equal(data.systemPrompt, harness.session.systemPrompt);
	assert.deepEqual(
		data.tools.map((tool) => tool.name),
		harness.session.agent.state.tools.map((tool) => tool.name),
	);
	assert.equal(entries.filter((entry) => entry.customType === "atomic.share").length, 1);
	const without = await harness.session.exportToJsonl(join(directory, "plain.jsonl"));
	assert.equal(
		fileLines(without).some((line) => line.includes("atomic.share")),
		false,
	);
});

test("an export closes the file it opened, whether it succeeds or fails (#4379)", async () => {
	const directory = temporaryDirectory("atomic-tool-output-export-close-");
	const { store, harness } = await sessionWithOutputs(directory, 2);
	const opened = vi.mocked(openSync);
	const closed = vi.mocked(closeSync);
	opened.mockClear();
	closed.mockClear();

	await harness.session.exportToJsonl(join(directory, "export.jsonl"));
	const descriptors = opened.mock.results.map((result) => result.value as number);
	assert.equal(descriptors.length, 1);
	assert.deepEqual(
		closed.mock.calls.map(([descriptor]) => descriptor),
		descriptors,
	);

	opened.mockClear();
	closed.mockClear();
	store.getBlob = async () => {
		throw new Error("disk read failed");
	};
	await assert.rejects(harness.session.exportToJsonl(join(directory, "failed.jsonl")), /disk read failed/);
	assert.deepEqual(
		closed.mock.calls.map(([descriptor]) => descriptor),
		opened.mock.results.map((result) => result.value as number),
	);
});

test("a failure to open the file is the export's failure alone, with nothing to clean up (#4379)", async () => {
	const directory = temporaryDirectory("atomic-tool-output-export-unopenable-");
	const { harness } = await sessionWithOutputs(directory, 1);
	const failure = Object.assign(new Error("no permission"), { code: "EACCES" });
	const actualOpen = (await vi.importActual<typeof import("node:fs")>("node:fs")).openSync;
	vi.mocked(openSync).mockImplementationOnce((() => {
		throw failure;
	}) as never);

	try {
		await assert.rejects(harness.session.exportToJsonl(join(directory, "export.jsonl")), (error) => {
			assert.equal(error, failure);
			assert.equal("cleanupCause" in (error as object), false, "removing a file that was never made is no failure");
			return true;
		});
	} finally {
		vi.mocked(openSync).mockImplementation(actualOpen as never);
	}
});

test("a failure to remove the partial file is attached to the export's failure, which stays the error (#4379)", async () => {
	const directory = temporaryDirectory("atomic-tool-output-export-unremovable-");
	const { store, harness } = await sessionWithOutputs(directory, 1);
	const failure = new Error("disk read failed");
	const removal = new Error("cannot remove");
	store.getBlob = async () => {
		throw failure;
	};
	const actualRemove = (await vi.importActual<typeof import("node:fs")>("node:fs")).rmSync;
	vi.mocked(rmSync).mockImplementationOnce((() => {
		throw removal;
	}) as never);

	try {
		await assert.rejects(harness.session.exportToJsonl(join(directory, "export.jsonl")), (error) => {
			assert.equal(error, failure);
			assert.equal((error as { cleanupCause?: unknown }).cleanupCause, removal);
			return true;
		});
	} finally {
		vi.mocked(rmSync).mockImplementation(actualRemove as never);
	}
});

const modeOf = (path: string) => statSync(path).mode & 0o777;

test.skipIf(process.platform === "win32")("a new export is readable by its owner alone (#4379)", async () => {
	const directory = temporaryDirectory("atomic-tool-output-export-mode-new-");
	const { harness } = await sessionWithOutputs(directory, 1);

	const path = await harness.session.exportToJsonl(join(directory, "export.jsonl"));

	assert.equal(modeOf(path), 0o600);
});

test.skipIf(process.platform === "win32")(
	"an export that replaces a file keeps that file's mode, narrow or wide (#4379)",
	async () => {
		const directory = temporaryDirectory("atomic-tool-output-export-mode-existing-");
		const { harness } = await sessionWithOutputs(directory, 1);
		const target = join(directory, "export.jsonl");
		for (const mode of [0o600, 0o640, 0o644]) {
			writeFileSync(target, "previous export");
			chmodSync(target, mode);

			await harness.session.exportToJsonl(target);

			assert.equal(modeOf(target), mode);
			assert.match(readFileSync(target, "utf8"), /"type":"session"/);
		}
	},
);

test.skipIf(process.platform === "win32")(
	"an export to a symbolic link replaces the file it points to (#4379)",
	async () => {
		const directory = temporaryDirectory("atomic-tool-output-export-link-");
		const { harness } = await sessionWithOutputs(directory, 1);
		const real = join(directory, "real.jsonl");
		const link = join(directory, "link.jsonl");
		writeFileSync(real, "previous export");
		chmodSync(real, 0o640);
		symlinkSync(real, link);

		await harness.session.exportToJsonl(link);

		assert.ok(lstatSync(link).isSymbolicLink(), "the link is still a link");
		assert.equal(readlinkSync(link), real);
		assert.match(readFileSync(real, "utf8"), /"type":"session"/);
		assert.equal(modeOf(real), 0o640);
		assert.deepEqual(
			readdirSync(directory).filter((name) => name.endsWith(".partial")),
			[],
		);
	},
);
