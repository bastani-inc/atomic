import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/atomic-ai/compat";
import type { TUI } from "@bastani/atomic-tui";
import { afterEach, test, vi } from "vitest";
import { AgentWakeDispatcher } from "../../packages/coding-agent/src/core/agent-wake-dispatcher.js";
import type { ToolDefinition } from "../../packages/coding-agent/src/core/extensions/types.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import { AgentTaskHost } from "../../packages/coding-agent/src/core/tasks/agent-adapter.js";
import { taskPanelItem } from "../../packages/coding-agent/src/core/tasks/agent-panel-source.js";
import { taskCompletionNotice } from "../../packages/coding-agent/src/core/tasks/completion.js";
import type { ActivityReport, Sequence, TaskId } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import {
	MIN_TASK_HEARTBEAT_MS,
	type TaskHeartbeatMessage,
	TaskHeartbeatMonitor,
} from "../../packages/coding-agent/src/core/tasks/heartbeat.js";
import { OwnerTaskStore } from "../../packages/coding-agent/src/core/tasks/owner-store.js";
import { AgentPanelModel } from "../../packages/coding-agent/src/modes/interactive/components/agent-panel.js";
import { taskMetricsText } from "../../packages/coding-agent/src/modes/interactive/components/task-row.js";
import { ToolExecutionComponent } from "../../packages/coding-agent/src/modes/interactive/components/tool-execution.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { SubagentParams } from "../../packages/subagents/src/extension/schemas.js";
import {
	renderSubagentToolCall,
	renderSubagentToolResult,
} from "../../packages/subagents/src/extension/tool-rendering.js";
import { runSync } from "../../packages/subagents/src/runs/foreground/execution.js";
import { runSingleInProcess } from "../../packages/subagents/src/runs/foreground/inprocess-run-sync.js";
import { runOwnerlessChild } from "../../packages/subagents/src/runs/foreground/ownerless-children.js";
import { subagentReleasePolicy } from "../../packages/subagents/src/runs/foreground/released-children.js";
import { createSubagentChildRecordSink } from "../../packages/subagents/src/runs/foreground/subagent-child-records.js";
import type { SubagentParamsLike } from "../../packages/subagents/src/runs/foreground/subagent-executor-types.js";
import { runAgentTask, taskToolResult } from "../../packages/subagents/src/runs/foreground/task-execution.js";
import { clearSubagentControls } from "../../packages/subagents/src/runs/inprocess/control-registry.js";
import type { Details, SingleResult, TaskExecutionHooks } from "../../packages/subagents/src/shared/types.js";
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

function paintLaunchCard(cwd: string, receipt: ReturnType<typeof taskToolResult>, host?: AgentTaskHost): string {
	initTheme("dark");
	const definition: ToolDefinition<typeof SubagentParams, Details, SubagentResultRenderState> = {
		name: "subagent",
		label: "Subagent",
		description: "Subagent launch card",
		parameters: SubagentParams,
		execute: async () => {
			throw new Error("Rendering must not execute the tool");
		},
		renderCall: (args, theme, context) => renderSubagentToolCall(args as SubagentParamsLike, theme, context),
		renderResult: renderSubagentToolResult,
	};
	const card = new ToolExecutionComponent(
		"subagent",
		"elapsed-card",
		{ agent: "waiter", task: "watch CI" },
		{ getTaskRecord: (id) => host?.taskRecords().find((task) => task.ref.taskId === id) },
		definition,
		{ requestRender() {} } as TUI,
		cwd,
	);
	try {
		card.updateResult({ ...receipt, isError: false });
		return stripVTControlCharacters(card.render(120).join("\n"));
	} finally {
		card.dispose();
	}
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

test("an SDK launch without a task host saves the same elapsed time as its result (#5570)", async () => {
	const env = await liveChildEnvironment(cleanups);
	let now = Date.now();
	const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
	let saved: number | undefined;
	try {
		const launch = runOwnerlessChild({
			cwd: env.root,
			agent: agent.name,
			task: "done",
			options: env.options("sdk-elapsed", { testSession: { output: "done" } }),
			recordChild: {
				record: (record) => {
					if (record.state === "terminal") saved = record.elapsedMs;
				},
			},
			runSync: (task, options) => {
				now += 1800;
				return runSingleInProcess(env.root, agent, task, options);
			},
		});
		const result = await launch.result;
		assert.equal(result.progressSummary?.durationMs, 1800);
		assert.equal(saved, 1800);
	} finally {
		clock.mockRestore();
	}
});

test("a heartbeat attached after dispatch counts the child's whole active span but not its queue wait (#5570)", async () => {
	const owner = SessionManager.inMemory(process.cwd());
	const host = new AgentTaskHost({
		scope: { kind: "session", sessionId: owner.getSessionId() },
		authorizeLaunch() {},
	});
	let now = Date.now();
	const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
	let beat: (() => void) | undefined;
	const delivered = Promise.withResolvers<TaskHeartbeatMessage>();
	const monitor = new TaskHeartbeatMonitor({
		...host.ownerBinding,
		delivery: () => ({
			defaultIntervalMs: () => MIN_TASK_HEARTBEAT_MS,
			hasUnreadHeartbeat: () => false,
			deliver: async (message) => delivered.resolve(message),
		}),
		clock: {
			now: () => now,
			setTimeout: (run) => {
				beat = run;
				return {};
			},
			clearTimeout: () => {
				beat = undefined;
			},
		},
	});
	const end = Promise.withResolvers<SingleResult>();
	const entered = Promise.withResolvers<void>();
	try {
		let dispatch: (() => Promise<void>) | undefined;
		const response = await runAgentTask({
			host,
			cwd: process.cwd(),
			agents: [agent],
			agent: agent.name,
			task: "stand by",
			options: { runId: "elapsed-queued" },
			wait: { kind: "background" },
			schedule: (run) => {
				dispatch = run;
			},
			runtime: {
				runSync: async () => {
					entered.resolve();
					return end.promise;
				},
			},
		});
		assert.ok(response.kind === "admitted" && dispatch);
		now += 500_000;
		void dispatch();
		await entered.promise;
		now += 12_000;
		monitor.start();
		assert.ok(beat);
		now += MIN_TASK_HEARTBEAT_MS;
		beat();
		assert.equal((await delivered.promise).details.tasks[0]?.elapsedMs, 12_000 + MIN_TASK_HEARTBEAT_MS);
		const row = host.taskRecords()[0]!;
		assert.equal(new AgentPanelModel().withElapsed(taskPanelItem(row)).elapsedMs, 12_000 + MIN_TASK_HEARTBEAT_MS);
	} finally {
		monitor.dispose();
		end.resolve({
			agent: agent.name,
			task: "stand by",
			status: "ok",
			messages: [],
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
		});
		await host.close("session-close");
		clock.mockRestore();
	}
});

test(
	"a resumed child's release notice, task row and result count session startup but not cleanup (#5570)",
	async () => {
		const env = await liveChildEnvironment(cleanups);
		const owner = SessionManager.inMemory(env.root);
		let receiptElapsed: number | undefined;
		const host = new AgentTaskHost({
			scope: { kind: "session", sessionId: owner.getSessionId() },
			authorizeLaunch() {},
			onTaskSettled: (_ref, _receipt, timing) => {
				receiptElapsed = timing?.elapsedMs;
			},
		});
		const view = new OwnerTaskStore(host.ownerBinding.supervisor, host.ownerBinding.owner);
		assert.ok(view.connect().ok);
		let now = Date.now();
		const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
		let opening = false;
		class TimedStore extends MemorySessionStore {
			override async readResume(...args: Parameters<MemorySessionStore["readResume"]>) {
				if (opening) {
					opening = false;
					now += 2100;
				}
				return super.readResume(...args);
			}
			override async releaseSession(id: string) {
				now += 30_000;
				await super.releaseSession(id);
			}
		}
		try {
			const sessionManager = await SessionManager.create(new TimedStore(), env.root);
			opening = true;
			env.faux.setResponses([
				fauxAssistantMessage([fauxToolCall("wait_for_ci", { run: "1" }, { id: "ci-1" })], {
					stopReason: "toolUse",
				}),
			]);
			let child: SingleResult | undefined;
			const response = await runAgentTask({
				host,
				cwd: env.root,
				agents: [agent],
				agent: "waiter",
				task: "watch CI",
				options: env.options("elapsed-resume", {
					sessionManager,
					resumeSession: true,
					releaseWhenWaiting: subagentReleasePolicy(10),
				}),
				wakeDispatcher: new AgentWakeDispatcher(),
				wait: { kind: "background" },
				runtime: { runSync },
				recordChild: createSubagentChildRecordSink(
					{ appendEntry: async (type, data) => void (await owner.appendCustomEntry(type, data)) },
					{ sessionManager: owner, orchestrationContext: undefined },
				),
				onTerminal: (value) => {
					child = value;
				},
			});
			assert.ok(response.kind === "admitted");
			const id = response.observation.taskId;
			const launchReceipt = taskToolResult(response, host);
			const settled = await host.waitForTask(id);
			assert.ok(settled.ok && settled.value.kind === "settled");
			const result = settled.value.result;
			assert.ok(result.kind === "cancelled" && result.released);
			view.drain();
			const row = view.taskRecord(id)!;
			const notice = taskCompletionNotice(
				{
					completionId: "release",
					ownerId: row.ref.ownerId,
					taskId: id,
					terminalSequence: "1" as Sequence,
					result,
					display: false,
				},
				row,
			);
			assert.equal(notice.line?.elapsedMs, 2100);
			assert.equal(taskMetricsText(row).split(" · ")[0], "2s");
			assert.equal(new AgentPanelModel().withElapsed(taskPanelItem(row)).elapsedMs, 2100);
			assert.equal(receiptElapsed, 2100, "notice replay without the live task record");
			assert.equal(child?.progress?.durationMs, 2100);
			assert.equal(child?.progressSummary?.durationMs, 2100);
			assert.match(paintLaunchCard(env.root, launchReceipt), /Waiting[^\n]* · 2s/, "replay has no live task host");
			assert.equal(taskToolResult(response, host).details?.taskRecords?.[0]?.metrics?.elapsedMs, 2100);
		} finally {
			clock.mockRestore();
			view.dispose();
			await host.close("session-close");
		}
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
		const text = paintLaunchCard(env.root, taskToolResult(response, host), host);
		assert.match(text, /Waiting on wait_for_ci · [1-9]\d*s/, text);
	},
	LIVE_CHILD_TIMEOUT_MS,
);
