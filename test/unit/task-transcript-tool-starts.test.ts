import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import type { AgentMessage } from "@bastani/atomic-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/atomic-ai/compat";
import { afterEach, test, vi } from "vitest";
import type { AgentSessionEvent } from "../../packages/coding-agent/src/core/agent-session.js";
import { _emit } from "../../packages/coding-agent/src/core/agent-session-events.js";
import type { AgentSessionInternalSurface } from "../../packages/coding-agent/src/core/agent-session-methods.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import type { TaskId } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import type { ChatBoxSession } from "../../packages/coding-agent/src/core/tasks/supervisor.js";
import {
	ownerTaskViewSource,
	type TaskTranscriptView,
	type TaskViewResult,
} from "../../packages/coding-agent/src/core/tasks/task-view-source.js";
import { TaskAgentTranscriptPage } from "../../packages/coding-agent/src/modes/interactive/components/task-transcript-page.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { PooledStageTaskSource } from "../../packages/workflows/src/workers/pooled-stage-task-source.js";
import { runStageTaskAction, snapshotStageTasks } from "../../packages/workflows/src/workers/stage-watch-tasks.js";
import { taskFixture } from "../helpers/task-projection.js";
import { taskTranscriptEnvironment, transcriptOnlySource } from "../helpers/task-transcript-environment.js";

afterEach(() => vi.useRealTimers());

function emitOn(session: object, event: object): void {
	_emit.call(session as AgentSessionInternalSurface, event as AgentSessionEvent);
}

const running = fauxAssistantMessage([fauxToolCall("read", { path: "slow.ts" }, { id: "slow" })], {
	stopReason: "toolUse",
});

test("a task transcript's latest page names the tool calls its session is running and when each started (#5350)", async () => {
	const fixture = taskFixture();
	const chatSession = { _eventListeners: [] };
	const history = SessionManager.inMemory();
	await history.appendMessage(running);
	try {
		await fixture.start("Running tool");
		fixture.runners[0]!.context.bindTranscript({
			getSessionId: () => history.getSessionId(),
			getEntries: () => history.getEntries(),
			chatSession: chatSession as unknown as ChatBoxSession,
		});
		const taskId = fixture.store.tasks[0]!.ref.taskId;
		const source = ownerTaskViewSource(fixture.store);
		const before = Date.now();
		emitOn(chatSession, { type: "tool_execution_start", toolCallId: "slow", toolName: "read", args: {} });
		const after = Date.now();
		const page = await source.readTaskTranscript(taskId);
		assert.ok(page.ok);
		const starts = page.value.activeToolStarts ?? [];
		assert.deepEqual(
			starts.map((start) => start.toolCallId),
			["slow"],
		);
		assert.ok(starts[0]!.startedAt >= before && starts[0]!.startedAt <= after);
		const relayed = await runStageTaskAction(source, taskId, { kind: "transcript" });
		assert.deepEqual(
			relayed.kind === "transcript" && relayed.result.ok ? relayed.result.value.activeToolStarts : undefined,
			starts,
		);
		emitOn(chatSession, {
			type: "tool_execution_end",
			toolCallId: "slow",
			toolName: "read",
			result: {},
			isError: false,
		});
		const ended = await source.readTaskTranscript(taskId);
		assert.equal(ended.ok ? ended.value.activeToolStarts : "unread", undefined);
	} finally {
		await fixture.dispose();
	}
});

test("a subagent chat on a worker follows its published retry, model switch and next request (#5572)", async () => {
	initTheme("dark");
	const fixture = taskFixture();
	const history = SessionManager.inMemory();
	await history.appendMessage(fauxAssistantMessage("Earlier reply"));
	const session = { isStreaming: true, retryStatus: undefined } as {
		isStreaming: boolean;
		retryStatus: ChatBoxSession["retryStatus"];
	};
	await fixture.start("Review changes");
	fixture.runners[0]!.context.bindTranscript({
		getSessionId: () => history.getSessionId(),
		getEntries: () => history.getEntries(),
		chatSession: session as ChatBoxSession,
		isRunning: () => session.isStreaming,
	});
	const source = ownerTaskViewSource(fixture.store);
	const pooled = new PooledStageTaskSource((id, action) => runStageTaskAction(source, id, action));
	const view = new TaskAgentTranscriptPage(
		pooled,
		fixture.store.tasks[0]!.ref.taskId,
		taskTranscriptEnvironment(),
		() => {},
	);
	const line = () =>
		view
			.render(80, 24)
			.map(stripVTControlCharacters)
			.find((row) => row.includes("∀"))
			?.trim();
	try {
		session.retryStatus = {
			type: "auto_retry_start",
			attempt: 1,
			maxAttempts: 1,
			delayMs: 2000,
			retryAt: Date.now() + 2000,
			errorMessage: "busy",
		};
		pooled.apply(snapshotStageTasks(source));
		await view.load();
		assert.equal(line(), "∀ Retrying…");
		session.retryStatus = {
			type: "model_fallback_start",
			from: "primary",
			to: "fallback",
			reason: "busy",
			attempt: 1,
		};
		pooled.apply(snapshotStageTasks(source));
		assert.equal(line(), "∀ Switching model…");
		session.retryStatus = undefined;
		pooled.apply(snapshotStageTasks(source));
		assert.equal(line(), "∀ Working…");
		session.isStreaming = false;
		pooled.apply(snapshotStageTasks(source));
		assert.equal(line(), undefined);
	} finally {
		view.dispose();
		await fixture.dispose();
	}
});

test("a hosted subagent's page opened mid-tool shows the factual elapsed time through later reads and the end (#5350)", async () => {
	initTheme("dark");
	vi.useFakeTimers();
	vi.setSystemTime(50_000_000);
	const startedAt = Date.now() - 8_000;
	let page: TaskTranscriptView = { messages: [running], activeToolStarts: [{ toolCallId: "slow", startedAt }] };
	const source = transcriptOnlySource({
		readTaskTranscript: (): TaskViewResult<TaskTranscriptView> => ({ ok: true, value: page }),
		followTaskTranscript: () => ({ historyOnly: true }),
	});
	const view = new TaskAgentTranscriptPage(source, "hosted" as TaskId, taskTranscriptEnvironment(), () => {});
	const header = () =>
		view
			.render(100, 30)
			.map((row) => stripVTControlCharacters(row))
			.find((row) => /Read\(/.test(row)) ?? "";
	try {
		await view.load();
		assert.match(header(), /· 8s/);
		vi.advanceTimersByTime(3_000);
		page = {
			messages: [running],
			activeToolStarts: [
				{ toolCallId: "slow", startedAt: Date.now() + 60_000 },
				{ toolCallId: "slow", startedAt: Number.NaN },
				{ toolCallId: "slow", startedAt: Date.now() - 1_000 },
			],
		};
		await view.load();
		assert.match(header(), /· 11s/);
		page = { messages: [running], activeToolStarts: [{ toolCallId: "slow", startedAt }] };
		await view.load();
		assert.match(header(), /· 11s/);
		const finished: AgentMessage = {
			role: "toolResult",
			toolCallId: "slow",
			toolName: "read",
			content: [{ type: "text", text: "line" }],
			isError: false,
			durationMs: 12_000,
			timestamp: 0,
		} as AgentMessage;
		page = { messages: [running, finished] };
		await view.load();
		assert.match(header(), /· 12s/);
	} finally {
		view.dispose();
	}
});
