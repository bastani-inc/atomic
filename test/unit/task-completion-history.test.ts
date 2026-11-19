import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import type { AssistantMessage, ToolResultMessage } from "@bastani/atomic-ai/compat";
import { setKeybindings } from "@bastani/atomic-tui";
import { test } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import {
	readSessionHistory,
	readSessionHistoryChunks,
} from "../../packages/coding-agent/src/core/storage/session/history-pages.js";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import { AgentTaskHost } from "../../packages/coding-agent/src/core/tasks/agent-adapter.js";
import { taskCompletionNotice } from "../../packages/coding-agent/src/core/tasks/completion.js";
import type {
	Cleanup,
	OperationId,
	OwnerId,
	Sequence,
	TaskId,
} from "../../packages/coding-agent/src/core/tasks/contracts.js";
import {
	loadTaskOwnTranscriptHistory,
	type TaskTranscriptSource,
} from "../../packages/coding-agent/src/core/tasks/supervisor.js";
import { readTaskCompletionHistory } from "../../packages/coding-agent/src/core/tasks/task-completion-history.js";
import { withTaskTranscriptArchive } from "../../packages/coding-agent/src/core/tasks/task-view-source.js";
import {
	TaskCompletionMessage,
	type TaskCompletionMessageOptions,
} from "../../packages/coding-agent/src/modes/interactive/components/task-completion-message.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { runSingleInProcess } from "../../packages/subagents/src/runs/foreground/inprocess-run-sync.ts";
import { clearSubagentControls } from "../../packages/subagents/src/runs/inprocess/control-registry.ts";
import { agent } from "../helpers/released-task-launch.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";
import { stripVTControlCharacters } from "../helpers/visible-text.ts";

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const assistant = (content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "toolUse") =>
	({
		role: "assistant",
		content,
		api: "test",
		provider: "test",
		model: "test",
		usage,
		stopReason,
		timestamp: 1,
	}) as AssistantMessage;
const result = (toolCallId: string, text: string): ToolResultMessage => ({
	role: "toolResult",
	toolCallId,
	toolName: "probe",
	content: [{ type: "text", text }],
	isError: false,
	timestamp: 1,
});
// Larger than a history page: read from the store or file a chunk at a time.
const oversized = (label: string) => `${label} ${"x".repeat(1_100_000)}`;

/** A settled child's own history after the history it inherited: calls, repeated and early results, oversized rows. */
async function appendOwnHistory(manager: SessionManager): Promise<void> {
	await manager.appendMessage({ role: "user", content: "Fix **#5220** spawn lock", timestamp: 2 });
	await manager.appendMessage(result("late-call", "late result, saved before its call"));
	await manager.appendMessage(
		assistant([
			{ type: "toolCall", id: "call-1", name: "lookup", arguments: { key: "lock" } },
			{ type: "toolCall", id: "late-call", name: "probe", arguments: { target: "late" } },
		]),
	);
	await manager.appendMessage(result("call-1", "superseded lookup"));
	await manager.appendMessage(result("call-1", "export const lock = 1;"));
	await manager.appendMessage(
		assistant([
			{ type: "text", text: oversized("unshown-answer") },
			{ type: "toolCall", id: "big-call", name: "probe", arguments: { target: "big" } },
		]),
	);
	await manager.appendMessage(result("big-call", `big result headline\n${oversized("big-tail")}`));
	await manager.appendMessage(result("unmatched", oversized("unshown-result")));
	await manager.appendMessage({ role: "user", content: oversized("unshown-follow-up"), timestamp: 3 });
	await manager.appendMessage(assistant([{ type: "text", text: "PR #5221 open" }], "stop"));
}

function notice(taskId: TaskId) {
	return taskCompletionNotice(
		{
			completionId: `completion-${taskId}`,
			ownerId: "owner" as OwnerId,
			taskId,
			terminalSequence: "1" as Sequence,
			result: {
				kind: "completed",
				output: {
					ownerId: "owner" as OwnerId,
					taskId,
					artifactId: `output:${taskId}`,
					byteCount: "13",
					omittedRanges: [],
				},
			},
			display: false,
		},
		{ kind: "agent", title: "#5220 spawn lock", agentName: "debugger", model: undefined, thinking: undefined },
		"PR #5221 open",
	);
}

/** The rows of an expanded card once its transcript is shown. */
async function expandedRows(taskId: TaskId, options: TaskCompletionMessageOptions): Promise<string[]> {
	let rendered = false;
	const card = new TaskCompletionMessage(notice(taskId), true, {
		...options,
		requestRender: () => {
			rendered = true;
		},
	});
	try {
		card.render(120);
		for (let i = 0; i < 400 && !rendered; i++) await new Promise((resolve) => setTimeout(resolve, 5));
		assert.ok(rendered, "the expanded card shows its transcript");
		return card.render(120);
	} finally {
		card.dispose();
	}
}

/** A settled child's transcript, as its runner keeps it, bound to a task whose inherited history ends at `throughId`. */
async function boundTask(host: AgentTaskHost, settled: TaskTranscriptSource, throughId: string) {
	let loads = 0;
	// A wrapper binding, as a foreground launch binds the runner's source; it counts whole-history reads.
	const counted: TaskTranscriptSource = withTaskTranscriptArchive(
		{
			getSessionId: () => settled.getSessionId(),
			getEntries: () => settled.getEntries(),
			loadHistory: () => {
				loads++;
				return settled.loadHistory!();
			},
			...(settled.readHistory ? { readHistory: settled.readHistory.bind(settled) } : {}),
			...(settled.readHistoryChunks ? { readHistoryChunks: settled.readHistoryChunks.bind(settled) } : {}),
			...(settled.getFallbackEntries ? { getFallbackEntries: settled.getFallbackEntries.bind(settled) } : {}),
		},
		settled,
	);
	const started = await host.startAgentTask(
		{ kind: "agent", agent: "debugger", task: "#5220 spawn lock", cwd: process.cwd() },
		`op-${throughId}` as OperationId,
		(context) => {
			context.bindTranscript({ getSessionId: () => "parent", getEntries: () => [{ id: throughId } as never] });
			context.bindTranscript(counted);
			return {
				result: Promise.resolve({
					kind: "completed" as const,
					output: {
						ownerId: context.ref.ownerId,
						taskId: context.ref.taskId,
						artifactId: `output:${context.ref.taskId}`,
						byteCount: "13",
						omittedRanges: [],
					},
				}),
				cleanup: Promise.resolve({ kind: "reaped" as const }),
			};
		},
	);
	assert.ok(started.ok);
	await host.waitForTask(started.value.taskId);
	const lease = host.resolveTask(started.value.taskId);
	assert.ok(lease.ok);
	return { taskId: started.value.taskId, lease: lease.value, loads: () => loads };
}

const backends = ["file", "memory", "sqlite"] as const;

test.each(backends)(
	"an expanded completion card reads a settled child's %s history a page at a time, with the rows of a whole read (#5593)",
	async (backend) => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
		const root = makeTempDirectory("task-completion-history-");
		const database = backend === "sqlite" ? await openNodeSqliteDatabase(":memory:") : undefined;
		const shared = database
			? await SqlSessionStore.open(database)
			: backend === "memory"
				? new MemorySessionStore()
				: undefined;
		const host = new AgentTaskHost({
			scope: { kind: "session", sessionId: `completion-history-${backend}` },
			authorizeLaunch() {},
		});
		try {
			const manager = shared && (await SessionManager.create(shared, root));
			let settled: TaskTranscriptSource | undefined;
			let cleanup: Promise<Cleanup> | undefined;
			const child = await runSingleInProcess(root, agent, "read the file", {
				cwd: root,
				sessionDir: root,
				runId: `completion-history-${backend}`,
				...(manager && { sessionManager: manager, resumeSession: true }),
				testSession: { output: "done" },
				taskExecution: {
					signal: new AbortController().signal,
					reportActivity() {},
					bindTranscript(source) {
						settled = source;
					},
					onExecution(run) {
						cleanup = run.cleanup;
					},
				},
			});
			await cleanup;
			assert.ok(settled?.loadHistory);
			const saved =
				shared && manager
					? await SessionManager.open(shared, manager.getSessionId())
					: await SessionManager.open(child.sessionFile!);
			const inheritedThrough = saved.getLeafId();
			assert.ok(inheritedThrough);
			try {
				await appendOwnHistory(saved);
			} finally {
				if (!shared) await saved.getSessionStore().close();
			}
			const task = await boundTask(host, settled, inheritedThrough);

			// What a whole read shows, as the card read it before.
			const whole = await expandedRows(task.taskId, {
				loadTranscript: () => loadTaskOwnTranscriptHistory(task.lease),
			});
			assert.equal(task.loads(), 1);
			let storeLoads = 0;
			if (shared) {
				const load = shared.load;
				Object.defineProperty(shared, "load", {
					configurable: true,
					get() {
						storeLoads++;
						return load;
					},
				});
			}
			const paged = await expandedRows(task.taskId, {
				loadTranscript: (_taskId, options) => readTaskCompletionHistory(task.lease, options?.signal),
			});
			assert.equal(task.loads(), 1, "the card never reads the whole history");
			assert.equal(storeLoads, 0, "the card never loads the whole session from its store");
			assert.deepEqual(paged, whole);

			const text = paged.map((row) => stripVTControlCharacters(row).trimEnd()).join("\n");
			assert.match(text, /⎿ {2}Prompt\n\s+Fix #5220 spawn lock\n/);
			assert.doesNotMatch(text, /read the file/, "the inherited history is not the task's own");
			assert.match(
				text,
				/lookup[\s\S]*export const lock = 1;[\s\S]*probe[\s\S]*late result, saved before its call[\s\S]*probe[\s\S]*big result headline/,
			);
			assert.doesNotMatch(text, /superseded lookup|unshown-/);
		} finally {
			await host.close("session-close");
			await shared?.close();
			await database?.close();
			clearSubagentControls();
			removeTempDirectory(root);
		}
	},
	120_000,
);

test("a completion card whose saved file is gone shows what the task kept and why, without a whole read (#5593)", async () => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
	const root = makeTempDirectory("task-completion-history-gone-");
	const host = new AgentTaskHost({ scope: { kind: "session", sessionId: "completion-gone" }, authorizeLaunch() {} });
	try {
		let settled: TaskTranscriptSource | undefined;
		let cleanup: Promise<Cleanup> | undefined;
		const child = await runSingleInProcess(root, agent, "read the file", {
			cwd: root,
			sessionDir: root,
			runId: "completion-history-gone",
			testSession: { output: "done" },
			taskExecution: {
				signal: new AbortController().signal,
				reportActivity() {},
				bindTranscript(source) {
					settled = source;
				},
				onExecution(run) {
					cleanup = run.cleanup;
				},
			},
		});
		await cleanup;
		assert.ok(settled?.loadHistory && child.sessionFile);
		const header = JSON.parse(readFileSync(child.sessionFile, "utf8").split("\n")[0]!) as { id: string };
		const task = await boundTask(host, settled, header.id);
		rmSync(child.sessionFile);

		const whole = await expandedRows(task.taskId, {
			loadTranscript: () => loadTaskOwnTranscriptHistory(task.lease),
		});
		assert.equal(task.loads(), 1);
		const paged = await expandedRows(task.taskId, {
			loadTranscript: (_taskId, options) => readTaskCompletionHistory(task.lease, options?.signal),
		});
		assert.equal(task.loads(), 1, "a missing file is reported without a whole read");
		assert.deepEqual(paged, whole);
		const text = paged.map((row) => stripVTControlCharacters(row).trimEnd()).join("\n");
		assert.match(text, /Transcript unavailable · History unavailable: the session file was moved or deleted/);
		assert.match(text, /⎿ {2}Prompt\n\s+read the file/);
	} finally {
		await host.close("session-close");
		clearSubagentControls();
		removeTempDirectory(root);
	}
}, 120_000);

test.each(["in a page", "too large for a page"] as const)(
	"every field a completion card shows reads the same from a saved row %s as from a whole read (#5593)",
	async (size) => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
		const store = new MemorySessionStore();
		const host = new AgentTaskHost({
			scope: { kind: "session", sessionId: `completion-fields-${size}` },
			authorizeLaunch() {},
		});
		try {
			const manager = await SessionManager.create(store, process.cwd());
			const inheritedThrough = await manager.appendMessage({
				role: "user",
				content: "inherited prompt",
				timestamp: 1,
			});
			// An unrelated field makes every row oversized, so each displayed field is selected from its chunks.
			const pad = size === "in a page" ? {} : { unshown: oversized("unshown-pad") };
			const messages: unknown[] = [
				{ role: "user", content: "", timestamp: 1 },
				{
					role: "user",
					content: [
						{ type: "image", data: "AAAA", mimeType: "image/png" },
						{ type: "text", text: "You are continuing from a fork\n\nTask:\nFix **the** lock" },
						{ type: "text", text: "now\n\n---\nUpdate progress at: /tmp/progress.md" },
					],
					timestamp: 1,
				},
				{ role: "user", content: "a later prompt", timestamp: 1 },
				result("early", "early output"),
				assistant([
					{ type: "thinking", thinking: "unshown-thinking" },
					{ type: "toolCall", id: "r1", name: "read", arguments: { path: "src/a.ts", offset: 3, limit: 10 } },
					{ type: "toolCall", id: "b1", name: "bash", arguments: { command: "ls -la\npwd" } },
					{ type: "toolCall", id: "early", name: "probe", arguments: { target: "early" } },
					{ type: "toolCall", id: 7, name: "probe", arguments: [1, 2] } as never,
					{ type: "toolCall", name: "probe", arguments: null } as never,
					{
						type: "toolCall",
						id: "e1",
						name: "edit",
						arguments: { path: "src/b.ts", oldText: "a", newText: "b" },
					},
				]),
				result("r1", "first read"),
				{ ...result("r1", "line1\nline2\nline3"), durationMs: 2500 },
				{ ...result("b1", "total 0\nfile"), isError: true, durationMs: 1200 },
				{ ...result("e1", "Edited"), details: { diff: "-a\n+b" } },
				{ ...result("__proto__", "unmatched"), content: "not an array" },
			];
			for (const message of messages) await manager.appendMessage({ ...(message as object), ...pad } as never);
			const sessionId = manager.getSessionId();
			const entries = (await store.load(sessionId)).entries;
			const task = await boundTask(
				host,
				{
					getSessionId: () => sessionId,
					getEntries: () => [],
					loadHistory: async () => ({ entries: [...entries] }),
					readHistory: (options) => readSessionHistory(store, sessionId, options),
					readHistoryChunks: (reference, options) => readSessionHistoryChunks(store, reference, options),
				},
				inheritedThrough,
			);
			const whole = await expandedRows(task.taskId, {
				loadTranscript: () => loadTaskOwnTranscriptHistory(task.lease),
				cwd: "/repo",
			});
			const paged = await expandedRows(task.taskId, {
				loadTranscript: (_taskId, options) => readTaskCompletionHistory(task.lease, options?.signal),
				cwd: "/repo",
			});
			assert.equal(task.loads(), 1, "only the reference read the whole history");
			assert.deepEqual(paged, whole);
			const text = paged.map((row) => stripVTControlCharacters(row).trimEnd()).join("\n");
			assert.match(text, /⎿ {2}Prompt\n\s+Fix the lock\n\s+now\n/);
			assert.doesNotMatch(text, /inherited prompt|a later prompt|unshown-|first read/);
		} finally {
			await host.close("session-close");
			await store.close();
		}
	},
);

test("folding or closing an expanded completion card stops the read only no other expanded card waits for (#5593)", async () => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
	const signals: AbortSignal[] = [];
	const never = new Promise<undefined>(() => {});
	const options: TaskCompletionMessageOptions = {
		loadTranscript: (_taskId, read) => {
			signals.push(read!.signal!);
			return never;
		},
	};
	const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
	const shown = notice("task-fold" as TaskId);

	const card = new TaskCompletionMessage(shown, false, options);
	card.render(100);
	await tick();
	assert.equal(signals.length, 0, "a folded card reads nothing");
	card.setExpanded(true);
	card.render(100);
	await tick();
	assert.equal(signals.length, 1);
	assert.equal(signals[0]!.aborted, false);
	card.setExpanded(false);
	assert.equal(signals[0]!.aborted, true, "folding stops the read");

	const first = new TaskCompletionMessage(shown, true, options);
	const second = new TaskCompletionMessage(shown, true, options);
	first.render(100);
	second.render(100);
	await tick();
	assert.equal(signals.length, 2, "cards showing the same notice share one read");
	first.setExpanded(false);
	assert.equal(signals[1]!.aborted, false, "the other expanded card still waits for it");
	second.dispose();
	assert.equal(signals[1]!.aborted, true, "closing the last card stops it");
});
