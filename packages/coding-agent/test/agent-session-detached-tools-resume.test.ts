/**
 * Handing results back to a session (#4309) in the situations around the ordinary ones: a session that is closed, one
 * that never held the call's tool, a transcript with no call at all, and where an oversized result is spilled.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@bastani/pi-ai/compat";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { afterEach, describe, test } from "vitest";
import { SessionManager } from "../src/core/session-manager.js";
import { openNodeSqliteDatabase } from "../src/core/storage/node-sqlite.js";
import { MemorySessionStore } from "../src/core/storage/session/memory-session-store.js";
import { SqlSessionStore } from "../src/core/storage/session/sql-session-store.js";
import {
	DEFAULT_MAX_RESULT_SIZE_CHARS,
	PERSISTED_OUTPUT_TAG,
	TOOL_RESULTS_SUBDIR,
} from "../src/core/tools/tool-limits.js";
import { isToolDetachmentError } from "../src/index.js";
import {
	detachedResult,
	harnessPool,
	persistedManager,
	reopenedAfterDetaching,
	settlesWithin,
	toolResultIds,
	untilStarted,
	waitForCiTurn,
	waitTool,
} from "./helpers/detached-tools.js";
import { createHarness, getMessageText, type Harness } from "./suite/harness.js";

const pool = harnessPool();
const directories: string[] = [];
const closers: (() => Promise<void>)[] = [];
const harnesses: Harness[] = [];
afterEach(async () => {
	await pool.cleanup();
	while (harnesses.length > 0) await harnesses.pop()?.cleanup();
	while (closers.length > 0) await closers.pop()?.();
	while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true });
});

function temporaryDirectory(prefix: string): string {
	const directory = mkdtempSync(join(tmpdir(), prefix));
	directories.push(directory);
	return directory;
}

const oversized = (): AgentToolResult => ({
	content: [{ type: "text", text: `BEGIN\n${"o".repeat(DEFAULT_MAX_RESULT_SIZE_CHARS + 1)}` }],
	details: undefined,
});

describe("handing results back to a session that cannot take them (#4309)", () => {
	test("a closed session refuses as closed before it looks at which call a result answers (#4309)", async () => {
		const tool = waitTool();
		const { reopened } = await reopenedAfterDetaching(pool, [tool.definition], [waitForCiTurn("ci-1")]);
		await reopened.session.dispose();

		await assert.rejects(reopened.session.resumeDetachedTurn([detachedResult("no-such-call", "passed")]), (error) => {
			assert.ok(isToolDetachmentError(error));
			assert.equal(error.code, "session-closed");
			return true;
		});
	});

	test("a transcript with no assistant message waits on no call: any result is for an unknown call (#4309)", async () => {
		const harness = await pool.harnessWith([waitTool().definition]);

		await assert.rejects(harness.session.resumeDetachedTurn([detachedResult("ci-1", "passed")]), (error) => {
			assert.ok(isToolDetachmentError(error));
			assert.equal(error.code, "unknown-tool-call");
			assert.equal(error.fields.toolCallId, "ci-1");
			return true;
		});
	});
});

describe("a session that does not hold the call's tool (#4309)", () => {
	test("still records the result its transcript is waiting on and continues the turn (#4309)", async () => {
		const tool = waitTool();
		const { manager, store } = await persistedManager();
		const first = await pool.harnessWith([tool.definition], manager);
		first.session.setToolDetachment({ afterMs: 0 });
		first.setResponses([waitForCiTurn("ci-1")]);
		await first.session.prompt("watch ci");
		first.session.takeDetachedToolCalls();
		const reopened = await pool.harnessWith([], await SessionManager.open(store, manager.getSessionId()));
		assert.equal(reopened.session.hasPendingDetachedTurn(), false, "the reopened session holds no detachable tool");
		reopened.setResponses([fauxAssistantMessage("ci passed")]);

		await reopened.session.resumeDetachedTurn([detachedResult("ci-1", "passed")]);

		assert.deepEqual(toolResultIds(reopened.sessionManager), ["ci-1"]);
		const [result] = reopened.sessionManager
			.buildSessionProjection()
			.messages.filter((message) => message.role === "toolResult");
		assert.ok(result?.role === "toolResult");
		assert.equal(result.isError, false);
		assert.equal(getMessageText(result), "passed");
		assert.equal(getMessageText(reopened.session.messages.at(-1)), "ci passed");
	});

	test("records the result of a call that shares its turn with text (#4309)", async () => {
		const tool = waitTool();
		const turn = fauxAssistantMessage(
			[fauxText("checking the run"), fauxToolCall("wait_for_ci", { run: "7" }, { id: "ci-1" })],
			{ stopReason: "toolUse" },
		);
		const { reopened } = await reopenedAfterDetaching(pool, [tool.definition], [turn]);
		reopened.setResponses([fauxAssistantMessage("ci passed")]);

		await reopened.session.resumeDetachedTurn([detachedResult("ci-1", "passed")]);

		assert.deepEqual(toolResultIds(reopened.sessionManager), ["ci-1"]);
		assert.equal(getMessageText(reopened.session.messages.at(-1)), "ci passed");
	});

	test("leaves none of the calls it recorded marked as in flight (#4309)", async () => {
		const tool = waitTool();
		const { reopened } = await reopenedAfterDetaching(pool, [tool.definition], [waitForCiTurn("ci-1")]);
		reopened.setResponses([fauxAssistantMessage("ci passed")]);
		const inFlight = (reopened.session as unknown as { readonly _reissuedToolCallIds: ReadonlySet<string> })
			._reissuedToolCallIds;

		await reopened.session.resumeDetachedTurn([detachedResult("ci-1", "passed")]);

		assert.deepEqual([...inFlight], []);
	});
});

describe("where a result is spilled (#4309)", () => {
	/** A call that detached, was handed back its oversized result by the session reopened with `options`. */
	async function savedAfterDetaching(options: {
		readonly firstManager: SessionManager;
		readonly reopenedManager: () => Promise<SessionManager>;
		readonly onReopened?: (reopened: Harness) => void;
	}): Promise<string> {
		const tool = waitTool();
		const first = await createHarness({ customTools: [tool.definition], sessionManager: options.firstManager });
		harnesses.push(first);
		first.session.setToolDetachment({ afterMs: 0 });
		first.setResponses([waitForCiTurn("ci-1")]);
		await first.session.prompt("watch ci");
		first.session.takeDetachedToolCalls();
		const reopened = await createHarness({
			customTools: [tool.definition],
			sessionManager: await options.reopenedManager(),
		});
		harnesses.push(reopened);
		options.onReopened?.(reopened);
		reopened.setResponses([fauxAssistantMessage("done")]);

		await reopened.session.resumeDetachedTurn([
			{ toolCallId: "ci-1", toolName: "wait_for_ci", result: oversized(), isError: false },
		]);

		const saved = reopened.sessionManager.buildSessionProjection().messages.find((m) => m.role === "toolResult");
		assert.ok(saved?.role === "toolResult");
		const message = getMessageText(saved);
		assert.ok(message.startsWith(PERSISTED_OUTPUT_TAG), "the oversized result was spilled");
		const path = /Full output saved to: (.+)\n/.exec(message)?.[1];
		assert.ok(path !== undefined, "the result names its file");
		return path;
	}

	/** What the model gets back when it reads the first line of `location` in the reopened session. */
	async function readByModel(reader: Harness, location: string): Promise<string> {
		reader.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: `${location}:1-1:raw` }, { id: "read-1" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("read it"),
		]);
		await reader.session.prompt("show the first line of the report");
		const read = reader.sessionManager
			.buildSessionProjection()
			.messages.find((message) => message.role === "toolResult" && message.toolCallId === "read-1");
		assert.ok(read?.role === "toolResult");
		assert.equal(read.isError, false, getMessageText(read));
		return getMessageText(read);
	}

	test("a session in memory keeps a released stage's result as a blob of the session, which the model reads (#4379)", async () => {
		const store = new MemorySessionStore();
		const manager = await SessionManager.create(store, process.cwd());
		let reader: Harness | undefined;

		const location = await savedAfterDetaching({
			firstManager: manager,
			reopenedManager: () => SessionManager.open(store, manager.getSessionId()),
			onReopened: (reopened) => {
				reader = reopened;
			},
		});

		const text = (oversized().content[0] as { readonly text: string }).text;
		const hash = createHash("sha256").update(text, "utf8").digest("hex");
		assert.equal(location, `tool-output://${hash}`);
		assert.equal(Buffer.from((await store.getBlob(manager.getSessionId(), hash))!).toString("utf8"), text);
		assert.match(await readByModel(reader!, location), /^BEGIN\b/);
	});

	test("the model reads a released stage's result back through the session's tool-output URL (#4379)", async () => {
		const directory = temporaryDirectory("atomic-spill-sql-");
		const database = await openNodeSqliteDatabase(join(directory, "sessions.sqlite"));
		const store = await SqlSessionStore.open(database);
		closers.push(async () => {
			await store.close();
			await database.close();
		});
		const manager = await SessionManager.create(store, process.cwd());
		let reader: Harness | undefined;

		const location = await savedAfterDetaching({
			firstManager: manager,
			reopenedManager: () => SessionManager.open(store, manager.getSessionId()),
			onReopened: (reopened) => {
				reader = reopened;
			},
		});
		assert.match(await readByModel(reader!, location), /^BEGIN\b/);
		assert.equal(existsSync(location), false, "no file stands behind the URL");
	});

	test("a session kept in a session directory spills into that directory's tool results (#4309)", async () => {
		const sessionDir = temporaryDirectory("atomic-spill-session-dir-");
		const tool = waitTool();
		const manager = await SessionManager.create(sessionDir, sessionDir);
		const harness = await pool.harnessWith([tool.definition], manager);
		harness.setResponses([waitForCiTurn("ci-1"), fauxAssistantMessage("done")]);

		const turn = harness.session.prompt("watch ci");
		await untilStarted(tool);
		tool.finishWith(0, oversized());
		await settlesWithin(turn);

		const saved = harness.sessionManager.buildSessionProjection().messages.find((m) => m.role === "toolResult");
		assert.ok(saved?.role === "toolResult");
		const path = /Full output saved to: (.+)\n/.exec(getMessageText(saved))?.[1];
		assert.ok(path !== undefined, "the result names its file");
		assert.equal(relative(join(manager.getSessionDir(), TOOL_RESULTS_SUBDIR), path).startsWith(".."), false);
	});
});

describe("a call made from inside a tool (#4309)", () => {
	test("keeps its whole output for the tool that made it; only the tool's own result is capped (#4309)", async () => {
		let seenLength = 0;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerTool({
						name: "child",
						label: "Child",
						description: "child",
						exposure: "codemode",
						parameters: Type.Object({}),
						execute: async () => oversized(),
					});
					pi.registerTool({
						name: "parent",
						label: "Parent",
						description: "parent",
						concurrency: "exclusive",
						parameters: Type.Object({}),
						execute: async (_id, _args, _signal, _update, ctx) => {
							const nested = await ctx.executeTool("child", {});
							seenLength = nested.result.content.reduce(
								(total, block) => total + (block.type === "text" ? block.text.length : 0),
								0,
							);
							return { content: [{ type: "text", text: "small" }], details: undefined };
						},
					});
				},
			],
			initialActiveToolNames: ["parent"],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("parent", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("run parent");

		assert.equal(seenLength, "BEGIN\n".length + DEFAULT_MAX_RESULT_SIZE_CHARS + 1);
	});
});
