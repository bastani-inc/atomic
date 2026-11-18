import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/atomic-ai/compat";
import type { TUI } from "@bastani/atomic-tui";
import { afterEach, test } from "vitest";
import { AgentWakeDispatcher } from "../../packages/coding-agent/src/core/agent-wake-dispatcher.js";
import type { ToolDefinition } from "../../packages/coding-agent/src/core/extensions/types.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import { AgentTaskHost } from "../../packages/coding-agent/src/core/tasks/agent-adapter.js";
import { taskCompletionNotice } from "../../packages/coding-agent/src/core/tasks/completion.js";
import type { ActivityReport, Sequence, TaskId } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import { ToolExecutionComponent } from "../../packages/coding-agent/src/modes/interactive/components/tool-execution.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { SubagentParams } from "../../packages/subagents/src/extension/schemas.js";
import {
	renderSubagentToolCall,
	renderSubagentToolResult,
} from "../../packages/subagents/src/extension/tool-rendering.js";
import { runSync } from "../../packages/subagents/src/runs/foreground/execution.js";
import { runSingleInProcess } from "../../packages/subagents/src/runs/foreground/inprocess-run-sync.js";
import { subagentReleasePolicy } from "../../packages/subagents/src/runs/foreground/released-children.js";
import { createSubagentChildRecordSink } from "../../packages/subagents/src/runs/foreground/subagent-child-records.js";
import type { SubagentParamsLike } from "../../packages/subagents/src/runs/foreground/subagent-executor-types.js";
import { runAgentTask, taskToolResult } from "../../packages/subagents/src/runs/foreground/task-execution.js";
import { clearSubagentControls } from "../../packages/subagents/src/runs/inprocess/control-registry.js";
import type { Details, TaskExecutionHooks } from "../../packages/subagents/src/shared/types.js";
import type { SubagentResultRenderState } from "../../packages/subagents/src/tui/render.js";
import { liveChildEnvironment } from "../helpers/live-child-environment.js";
import { agent } from "../helpers/released-task-launch.js";
import { sleep } from "../helpers/runtime.js";

/** A live child loads its real resources; that is the structural cost of these tests. */
const LIVE_CHILD_TIMEOUT_MS = 120_000;
const CONDITION_WAIT_MS = 30_000;
/** How long each child sits in its tool call before it is released or stopped: its elapsed time must cover it. */
const HOLD_MS = 1_500;

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length > 0) cleanups.pop()?.();
	clearSubagentControls();
});

async function until(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + CONDITION_WAIT_MS;
	while (!predicate() && Date.now() < deadline) await sleep(5);
	assert.ok(predicate(), "condition never held");
}

/** Task hooks that keep every metrics report the child sends. */
function metricsHooks(signal: AbortSignal, reports: number[]): TaskExecutionHooks {
	return {
		signal,
		reportActivity(report: ActivityReport) {
			if (report.change.kind === "metrics" && report.change.elapsedMs !== undefined)
				reports.push(report.change.elapsedMs);
		},
		onExecution() {},
		yieldTaskWait() {},
		isParentObserving: () => false,
	};
}

test(
	"a child released while it waits reports its elapsed time up to the release (#5496)",
	async () => {
		const env = await liveChildEnvironment(cleanups);
		env.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("wait_for_ci", { run: "1" }, { id: "ci-1" })], { stopReason: "toolUse" }),
		]);
		const reports: number[] = [];
		const result = await runSingleInProcess(env.root, agent, "watch CI", {
			...env.options("elapsed-release", {
				sessionManager: await SessionManager.create(new MemorySessionStore(), env.root),
				resumeSession: true,
				releaseWhenWaiting: subagentReleasePolicy(HOLD_MS),
				taskExecution: metricsHooks(new AbortController().signal, reports),
			}),
		});
		assert.equal(result.status, "interrupted");
		assert.deepEqual(
			result.released?.waitingOn.map((call) => call.toolCallId),
			["ci-1"],
		);
		assert.ok((reports.at(-1) ?? 0) >= HOLD_MS, `last reported elapsed: ${reports.at(-1)} ms`);
	},
	LIVE_CHILD_TIMEOUT_MS,
);

test.each(["pause", "quit", "user"] as const)(
	"a child stopped (%s) in the middle of a tool call reports its elapsed time up to the stop (#5496)",
	async (reason) => {
		const env = await liveChildEnvironment(cleanups);
		env.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("block", {}, { id: "block-1" })], { stopReason: "toolUse" }),
		]);
		const reports: number[] = [];
		const stop = new AbortController();
		const run = runSingleInProcess(env.root, agent, "run until stopped", {
			...env.options(`elapsed-stop-${reason}`, {
				signal: stop.signal,
				taskExecution: metricsHooks(stop.signal, reports),
			}),
		});
		await until(env.blockStarted);
		await sleep(HOLD_MS);
		stop.abort(reason);
		const result = await run;
		assert.notEqual(result.status, "ok");
		assert.ok((reports.at(-1) ?? 0) >= HOLD_MS, `last reported elapsed: ${reports.at(-1)} ms`);
	},
	LIVE_CHILD_TIMEOUT_MS,
);

test(
	"a released background subagent's task record and notice show its time up to the release (#5496)",
	async () => {
		const env = await liveChildEnvironment(cleanups);
		const owner = SessionManager.inMemory(env.root);
		const host = new AgentTaskHost({
			scope: { kind: "session", sessionId: owner.getSessionId() },
			authorizeLaunch() {},
		});
		cleanups.push(() => void host.close("session-close"));
		env.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("wait_for_ci", { run: "1" }, { id: "ci-1" })], { stopReason: "toolUse" }),
		]);
		const response = await runAgentTask({
			host,
			cwd: env.root,
			agents: [agent],
			agent: "waiter",
			task: "watch CI",
			options: {
				...env.options("elapsed-notice", {
					sessionManager: await SessionManager.create(new MemorySessionStore(), env.root),
					resumeSession: true,
					releaseWhenWaiting: subagentReleasePolicy(HOLD_MS),
					intercomSessionName: "subagent-waiter-elapsed-notice",
				}),
				index: 0,
			},
			wakeDispatcher: new AgentWakeDispatcher(),
			wait: { kind: "background" },
			recordChild: createSubagentChildRecordSink(
				{ appendEntry: async (type, data) => void (await owner.appendCustomEntry(type, data)) },
				{ sessionManager: owner, orchestrationContext: undefined },
			),
			runtime: { runSync },
		});
		assert.ok(response.kind === "admitted");
		const taskId = response.observation.taskId as TaskId;
		const settled = await host.waitForTask(taskId);
		assert.ok(settled.ok && settled.value.kind === "settled", JSON.stringify(settled));
		const result = settled.value.result;
		assert.ok(result.kind === "cancelled" && result.released !== undefined, JSON.stringify(result));
		const record = host.taskRecords().find((task) => task.ref.taskId === taskId);
		assert.ok(record);
		assert.ok((record.metrics?.elapsedMs ?? 0) >= HOLD_MS, `recorded elapsed: ${record.metrics?.elapsedMs} ms`);
		const notice = taskCompletionNotice(
			{
				completionId: "elapsed-notice",
				ownerId: record.ref.ownerId,
				taskId,
				terminalSequence: "1" as Sequence,
				result,
				display: false,
			},
			record,
		);
		assert.ok((notice.line?.elapsedMs ?? 0) >= HOLD_MS, `notice elapsed: ${notice.line?.elapsedMs} ms`);

		// The parent's launch card reads the same time.
		initTheme("dark");
		const definition: ToolDefinition<typeof SubagentParams, Details, SubagentResultRenderState> = {
			name: "subagent",
			label: "Subagent",
			description: "Subagent launch card",
			parameters: SubagentParams,
			execute: async () => {
				throw new Error("Rendering must not execute the tool");
			},
			renderCall: (args, callTheme, context) =>
				renderSubagentToolCall(args as SubagentParamsLike, callTheme, context),
			renderResult: renderSubagentToolResult,
		};
		const card = new ToolExecutionComponent(
			"subagent",
			"elapsed-card",
			{ agent: "waiter", task: "watch CI" },
			{ getTaskRecord: (id) => host.taskRecords().find((task) => task.ref.taskId === id) },
			definition,
			{ requestRender() {} } as TUI,
			env.root,
		);
		cleanups.push(() => card.dispose());
		card.updateResult({ ...taskToolResult(response, host), isError: false });
		const text = stripVTControlCharacters(card.render(120).join("\n"));
		assert.match(text, /Waiting on wait_for_ci · [1-9]\d*s/, text);
	},
	LIVE_CHILD_TIMEOUT_MS,
);
