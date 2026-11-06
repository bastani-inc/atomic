/**
 * A detached call's result enters history exactly as an inline call's does (#4309): extension `tool_result`
 * handlers, image normalization and the oversized-output spill, which is content-addressed. A released stage's spill
 * lands in a per-session directory of the agent blobs that deleting the session removes.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fauxAssistantMessage, fauxToolCall, type ToolResultMessage } from "@bastani/pi-ai/compat";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { afterEach, describe, test } from "vitest";
import type { ExtensionFactory, ToolDefinition } from "../src/core/extensions/index.js";
import { SessionManager } from "../src/core/session-manager.js";
import { openNodeSqliteDatabase } from "../src/core/storage/node-sqlite.js";
import { MemorySessionStore } from "../src/core/storage/session/memory-session-store.js";
import { SqlSessionStore } from "../src/core/storage/session/sql-session-store.js";
import { redirectOversizedToolResult } from "../src/core/tools/oversized-tool-result.js";
import { runSessionTempCleanup } from "../src/core/tools/session-temp-cleanup.js";
import { getTempRootDir } from "../src/core/tools/session-temp-dir.js";
import {
	DEFAULT_MAX_RESULT_SIZE_CHARS,
	PERSISTED_OUTPUT_TAG,
	TOOL_RESULT_BLOBS_SUBDIR,
} from "../src/core/tools/tool-limits.js";
import { getReleasedStageBlobDir } from "../src/core/tools/tool-output-blobs.js";
import { createHarness, getMessageText, type Harness } from "./suite/harness.js";

const harnesses: Harness[] = [];
const directories: string[] = [];
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
	while (harnesses.length > 0) await harnesses.pop()?.cleanup();
	while (closers.length > 0) await closers.pop()?.();
	while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true });
});

/** A session store that persists: SQLite in the agent directory, as the default storage keeps sessions. */
async function persistentStore(agentDir: string): Promise<SqlSessionStore> {
	const database = await openNodeSqliteDatabase(join(agentDir, `sessions-${closers.length}.sqlite`));
	const store = await SqlSessionStore.open(database);
	closers.push(async () => {
		await store.close();
		await database.close();
	});
	return store;
}

function temporaryDirectory(prefix: string): string {
	const directory = mkdtempSync(join(tmpdir(), prefix));
	directories.push(directory);
	return directory;
}

async function harness(options: Parameters<typeof createHarness>[0]): Promise<Harness> {
	const created = await createHarness(options);
	harnesses.push(created);
	return created;
}

/** A detachable tool whose one call reports `output` once the test lets it. */
function reportingTool(): { readonly definition: ToolDefinition; report(output: AgentToolResult): void } {
	const reported = Promise.withResolvers<AgentToolResult>();
	return {
		report: (output) => reported.resolve(output),
		definition: {
			name: "fetch_report",
			label: "Fetch report",
			description: "Fetches a report",
			parameters: Type.Object({ run: Type.String() }),
			detachable: true,
			execute: () => reported.promise,
		},
	};
}

const reportTurn = () =>
	fauxAssistantMessage([fauxToolCall("fetch_report", { run: "7" }, { id: "report-1" })], { stopReason: "toolUse" });

function savedResult(manager: SessionManager): ToolResultMessage {
	const result = manager.buildSessionProjection().messages.find((message) => message.role === "toolResult");
	assert.ok(result?.role === "toolResult", "the call's result was saved");
	return result;
}

interface Run {
	readonly agentDir: string;
	readonly extensionFactories?: ExtensionFactory[];
}

/** The result a session in a store saves for one call that runs inline and reports `output`. */
async function savedInline(output: AgentToolResult, run: Run): Promise<ToolResultMessage> {
	const tool = reportingTool();
	const inline = await harness({
		customTools: [tool.definition],
		sessionManager: await SessionManager.create(await persistentStore(run.agentDir), process.cwd()),
		storageAgentDir: run.agentDir,
		...(run.extensionFactories === undefined ? {} : { extensionFactories: run.extensionFactories }),
	});
	inline.setResponses([reportTurn(), fauxAssistantMessage("done")]);
	tool.report(output);
	await inline.session.prompt("fetch the report");
	return savedResult(inline.sessionManager);
}

/**
 * The result a session in a store saves for the same call when it detached, reported `output` after its session was
 * released, and was handed to the session reopened from the store.
 */
async function savedDetached(output: AgentToolResult, run: Run): Promise<ToolResultMessage> {
	return (await detachedSession(output, run)).saved;
}

interface DetachedSession {
	readonly saved: ToolResultMessage;
	readonly sessionId: string;
	readonly store: SqlSessionStore;
}

async function detachedSession(output: AgentToolResult, run: Run): Promise<DetachedSession> {
	const tool = reportingTool();
	const store = await persistentStore(run.agentDir);
	const manager = await SessionManager.create(store, process.cwd());
	const first = await createHarness({
		customTools: [tool.definition],
		sessionManager: manager,
		storageAgentDir: run.agentDir,
	});
	first.session.setToolDetachment({ afterMs: 0 });
	first.setResponses([reportTurn()]);
	await first.session.prompt("fetch the report");
	const [call] = first.session.takeDetachedToolCalls();
	assert.ok(call !== undefined, "the call detached");
	await first.cleanup();
	tool.report(output);
	const result = await call.result;

	const reopened = await harness({
		customTools: [tool.definition],
		sessionManager: await SessionManager.open(store, manager.getSessionId()),
		storageAgentDir: run.agentDir,
		...(run.extensionFactories === undefined ? {} : { extensionFactories: run.extensionFactories }),
	});
	reopened.setResponses([fauxAssistantMessage("done")]);
	await reopened.session.resumeDetachedTurn([result]);
	return { saved: savedResult(reopened.sessionManager), sessionId: manager.getSessionId(), store };
}

function textResult(text: string): AgentToolResult {
	return { content: [{ type: "text", text }], details: undefined };
}

function savedFilePath(text: string): string {
	const path = /Full output saved to: (.+)\n/.exec(text)?.[1];
	assert.ok(path !== undefined, `no saved path in ${text.slice(0, 200)}`);
	return path;
}

function sha256(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

describe("a detached call's result is finalized as an inline call's is (#4309)", () => {
	test("an oversized result is spilled, so what is saved stays under the cap, inline or detached (#4309)", async () => {
		const agentDir = temporaryDirectory("atomic-detached-spill-");
		const output = `BEGIN-REPORT\n${"r".repeat(200_000)}\nEND-REPORT`;

		const inline = await savedInline(textResult(output), { agentDir });
		const detached = await savedDetached(textResult(output), { agentDir });

		for (const saved of [inline, detached]) {
			const text = getMessageText(saved);
			assert.ok(text.startsWith(PERSISTED_OUTPUT_TAG));
			assert.ok(text.length <= DEFAULT_MAX_RESULT_SIZE_CHARS, `saved ${text.length} characters`);
			assert.ok(text.includes("BEGIN-REPORT"));
			assert.ok(!text.includes("END-REPORT"));
			assert.equal(readFileSync(savedFilePath(text), "utf8"), output);
		}
		const withoutPath = (saved: ToolResultMessage) =>
			getMessageText(saved).replace(savedFilePath(getMessageText(saved)), "<path>");
		assert.equal(withoutPath(detached), withoutPath(inline));
	});

	test("a tool_result extension sees the detached call and its redaction is what is saved (#4309)", async () => {
		const agentDir = temporaryDirectory("atomic-detached-redaction-");
		const seen: { readonly toolCallId: string; readonly input: Record<string, unknown> }[] = [];
		const redacting: ExtensionFactory = (pi) => {
			pi.on("tool_result", (event) => {
				seen.push({ toolCallId: event.toolCallId, input: event.input });
				return {
					content: event.content.map((block) =>
						block.type === "text"
							? { ...block, text: block.text.replace(/secret=\S+/g, "secret=[redacted]") }
							: block,
					),
				};
			});
		};
		const output = textResult("deploy token secret=hunter2 accepted");

		const inline = await savedInline(output, { agentDir, extensionFactories: [redacting] });
		const detached = await savedDetached(output, { agentDir, extensionFactories: [redacting] });

		assert.deepEqual(detached.content, [{ type: "text", text: "deploy token secret=[redacted] accepted" }]);
		assert.deepEqual(detached.content, inline.content);
		assert.deepEqual(seen, [
			{ toolCallId: "report-1", input: { run: "7" } },
			{ toolCallId: "report-1", input: { run: "7" } },
		]);
	});

	test("an image in a detached result is normalized for the provider, as an inline one is (#4309)", async () => {
		const agentDir = temporaryDirectory("atomic-detached-image-");
		const bmp = Buffer.alloc(58);
		bmp.write("BM", 0, "ascii");
		bmp.writeUInt32LE(bmp.length, 2);
		bmp.writeUInt32LE(54, 10);
		bmp.writeUInt32LE(40, 14);
		bmp.writeInt32LE(1, 18);
		bmp.writeInt32LE(1, 22);
		bmp.writeUInt16LE(1, 26);
		bmp.writeUInt16LE(24, 28);
		bmp.writeUInt32LE(4, 34);
		bmp[56] = 0xff;
		const output: AgentToolResult = {
			content: [{ type: "image", data: bmp.toString("base64"), mimeType: "image/bmp" }],
			details: undefined,
		};

		const inline = await savedInline(output, { agentDir });
		const detached = await savedDetached(output, { agentDir });

		assert.equal(detached.content[0]?.type === "image" && detached.content[0].mimeType, "image/png");
		assert.deepEqual(detached.content[1], { type: "text", text: "[Image converted from image/bmp to image/png.]" });
		assert.deepEqual(detached.content, inline.content);
	});
});

describe("persisted oversized output (#4309)", () => {
	test("is named by the SHA-256 of its content: identical outputs share one file the transcript references (#4309)", async () => {
		const blobDir = getReleasedStageBlobDir(temporaryDirectory("atomic-blob-dedupe-"), "blob-session");
		const output = "d".repeat(DEFAULT_MAX_RESULT_SIZE_CHARS + 5);
		const spill = (toolCallId: string, text: string) =>
			redirectOversizedToolResult({
				toolName: "bash",
				toolCallId,
				result: { content: [{ type: "text", text }], details: undefined },
				isError: false,
				sessionId: "blob-session",
				blobDir,
			});

		const first = getMessageText(await spill("call-1", output));
		const second = getMessageText(await spill("call-2", output));
		const other = getMessageText(await spill("call-3", `${output}e`));

		assert.equal(savedFilePath(first), join(blobDir, `${sha256(output)}.txt`));
		assert.ok(first.includes(`sha256:${sha256(output)}`));
		assert.equal(second, first);
		assert.equal(savedFilePath(other), join(blobDir, `${sha256(`${output}e`)}.txt`));
		assert.deepEqual(readdirSync(blobDir).sort(), [`${sha256(output)}.txt`, `${sha256(`${output}e`)}.txt`].sort());
	});

	test("of a released stage lands in its session's directory of the agent blobs, outside every tree the sweeper reaps (#4309)", async () => {
		const agentDir = temporaryDirectory("atomic-blob-durable-");
		const sandbox = temporaryDirectory("atomic-blob-sweep-");
		const output = `DURABLE\n${"s".repeat(DEFAULT_MAX_RESULT_SIZE_CHARS + 1)}`;

		const { saved, sessionId } = await detachedSession(textResult(output), { agentDir });
		await harnesses.pop()?.cleanup();
		const path = savedFilePath(getMessageText(saved));

		assert.equal(dirname(path), join(agentDir, TOOL_RESULT_BLOBS_SUBDIR, sessionId));
		assert.equal(dirname(path), getReleasedStageBlobDir(agentDir, sessionId));
		assert.equal(path, join(getReleasedStageBlobDir(agentDir, sessionId), `${sha256(output)}.txt`));
		assert.ok(relative(getTempRootDir(), path).startsWith(".."), `${path} is in the age-swept temp tree`);
		runSessionTempCleanup({
			now: Date.now() + 365 * 24 * 60 * 60 * 1000,
			tempRoot: join(sandbox, "temp"),
			sessionsRoots: [join(agentDir, "sessions")],
			sessionDirs: [agentDir],
			controlRoot: join(sandbox, "control"),
		});
		assert.equal(existsSync(path), true);
		assert.equal(readFileSync(path, "utf8"), output);
	});

	test("of a released stage is removed with its session, and only with its session (#4309)", async () => {
		const agentDir = temporaryDirectory("atomic-blob-delete-");
		const output = `DELETED\n${"d".repeat(DEFAULT_MAX_RESULT_SIZE_CHARS + 1)}`;
		const kept = await detachedSession(textResult(`${output}-kept`), { agentDir });
		const deleted = await detachedSession(textResult(output), { agentDir });
		const keptPath = savedFilePath(getMessageText(kept.saved));
		const deletedPath = savedFilePath(getMessageText(deleted.saved));
		await harnesses.pop()?.cleanup();
		await harnesses.pop()?.cleanup();
		assert.equal(existsSync(deletedPath), true);

		const manager = await SessionManager.create(deleted.store, process.cwd());
		manager.bindAgentDir(agentDir);
		await manager.deleteSession(deleted.sessionId);

		assert.equal(existsSync(getReleasedStageBlobDir(agentDir, deleted.sessionId)), false);
		assert.equal(existsSync(keptPath), true);
	});

	test("of a session that ran inline goes to the temp tree the sweeper reaps, not the agent blobs, even in a store (#4309)", async () => {
		const agentDir = temporaryDirectory("atomic-blob-inline-");

		const saved = await savedInline(textResult("i".repeat(DEFAULT_MAX_RESULT_SIZE_CHARS + 1)), { agentDir });

		const path = savedFilePath(getMessageText(saved));
		assert.equal(existsSync(join(agentDir, TOOL_RESULT_BLOBS_SUBDIR)), false);
		assert.ok(!relative(getTempRootDir(), path).startsWith(".."), `${path} is outside the temp tree`);
	});

	test("of a session that is not persisted stays in the temp tree the sweeper reaps, never in the agent directory (#4309)", async () => {
		const agentDir = temporaryDirectory("atomic-blob-unpersisted-");
		const tool = reportingTool();
		const unpersisted = await harness({
			customTools: [tool.definition],
			sessionManager: await SessionManager.create(new MemorySessionStore(), process.cwd()),
			storageAgentDir: agentDir,
		});
		unpersisted.setResponses([reportTurn(), fauxAssistantMessage("done")]);
		tool.report(textResult("t".repeat(DEFAULT_MAX_RESULT_SIZE_CHARS + 1)));
		await unpersisted.session.prompt("fetch the report");

		const path = savedFilePath(getMessageText(savedResult(unpersisted.sessionManager)));
		assert.equal(existsSync(join(agentDir, TOOL_RESULT_BLOBS_SUBDIR)), false);
		assert.ok(!relative(getTempRootDir(), path).startsWith(".."), `${path} is outside the temp tree`);
	});
});
