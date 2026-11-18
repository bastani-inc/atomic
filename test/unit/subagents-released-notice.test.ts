import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import type { ExtensionContext } from "@bastani/atomic";
import { fauxAssistantMessage, fauxToolCall, type Message } from "@bastani/atomic-ai/compat";
import { afterEach, test } from "vitest";
import { AgentWakeDispatcher } from "../../packages/coding-agent/src/core/agent-wake-dispatcher.js";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { AgentTaskHost } from "../../packages/coding-agent/src/core/tasks/agent-adapter.js";
import { taskPanelItems } from "../../packages/coding-agent/src/core/tasks/agent-panel-source.js";
import { createChildCommandTaskOwner } from "../../packages/coding-agent/src/core/tasks/child-command-owner.js";
import {
	formatTaskCompletion,
	withoutSupersededAttempts,
} from "../../packages/coding-agent/src/core/tasks/completion.js";
import type { OperationId, OwnerId, Sequence, TaskId } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import { loadTaskOwnTranscriptHistory } from "../../packages/coding-agent/src/core/tasks/supervisor.js";
import { taskBoardGroups } from "../../packages/coding-agent/src/modes/interactive/components/task-board.js";
import { renderTaskFooter } from "../../packages/coding-agent/src/modes/interactive/components/task-list.js";
import { TaskNavigation } from "../../packages/coding-agent/src/modes/interactive/components/task-navigation.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import type { AgentConfig } from "../../packages/subagents/src/agents/agent-types.ts";
import { SUBAGENT_SUPERVISOR_AUTHORIZATION_EVENT } from "../../packages/subagents/src/intercom/supervisor-authorization.js";
import { runSync } from "../../packages/subagents/src/runs/foreground/execution.js";
import { bindReleasedChildWakes } from "../../packages/subagents/src/runs/foreground/released-child-wakes.js";
import { subagentReleasePolicy } from "../../packages/subagents/src/runs/foreground/released-children.js";
import {
	createSubagentChildRecordSink,
	readSubagentChildRecords,
	SUBAGENT_CHILD_RELEASED_STATUS,
	type SubagentChildRecord,
} from "../../packages/subagents/src/runs/foreground/subagent-child-records.js";
import {
	SUBAGENT_AWAIT_INTERCOM_PEER_EVENT,
	SUBAGENT_RELEASE_RESTORING_CHILD_EVENT,
	SUBAGENT_RESERVE_RESTORING_CHILD_EVENT,
} from "../../packages/subagents/src/runs/foreground/subagent-child-restore.js";
import type { ExecutorDeps } from "../../packages/subagents/src/runs/foreground/subagent-executor-types.js";
import { runAgentTask, subagentTaskResultLabel } from "../../packages/subagents/src/runs/foreground/task-execution.js";
import { clearSubagentControls } from "../../packages/subagents/src/runs/inprocess/control-registry.ts";
import type { RunSyncOptions } from "../../packages/subagents/src/shared/types.ts";
import { liveChildEnvironment } from "../helpers/live-child-environment.js";
import { sleep } from "../helpers/runtime.js";

/** A live child loads its real resources and runs a real shell; that is the structural cost of this test. */
const LIVE_CHILD_TIMEOUT_MS = 120_000;
const RECORD_WAIT_MS = 30_000;
const shellTool = process.platform === "win32" ? "powershell" : "bash";
const shellCommand =
	process.platform === "win32" ? "$v = [Console]::ReadLine(); Write-Output 'built'" : "read v; printf built";

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length > 0) cleanups.pop()?.();
	clearSubagentControls();
});

const agent: AgentConfig = {
	name: "builder",
	description: "builds and waits for the build",
	systemPrompt: "",
	systemPromptMode: "replace",
	inheritProjectContext: false,
	inheritSkills: false,
	source: "user",
	filePath: "/tmp/builder.md",
};

/** The id of the background shell task the child's first call started, read from its result. */
function shellTaskId(messages: readonly Message[]): string {
	for (const message of messages)
		if (message.role === "toolResult" && message.toolCallId === "sh-1") {
			const taskId = (message.details as { observation?: { taskId?: string } } | undefined)?.observation?.taskId;
			if (taskId) return taskId;
		}
	throw new Error("the child's shell call returned no task id");
}

/** Events the owner side answers as Intercom and the supervisor would, so a wake can restore the child. */
function ownerEvents(): ExecutorDeps["pi"]["events"] {
	return {
		on: () => () => {},
		emit(channel: string, data: object) {
			if (channel === SUBAGENT_SUPERVISOR_AUTHORIZATION_EVENT) {
				const request = data as { childName: string; completion?: Promise<object> };
				request.completion = Promise.resolve({
					capability: `capability-${randomUUID()}`,
					supervisorSessionId: "parent",
					childName: request.childName,
				});
			}
			if (channel === SUBAGENT_AWAIT_INTERCOM_PEER_EVENT)
				(data as { completion?: Promise<boolean> }).completion = Promise.resolve(true);
			if (channel === SUBAGENT_RESERVE_RESTORING_CHILD_EVENT || channel === SUBAGENT_RELEASE_RESTORING_CHILD_EVENT)
				(data as { completion?: Promise<void> }).completion = Promise.resolve();
		},
	} as unknown as ExecutorDeps["pi"]["events"];
}

async function recordUntil(
	owner: SessionManager,
	childId: string,
	accept: (record: SubagentChildRecord) => boolean,
): Promise<SubagentChildRecord> {
	const deadline = Date.now() + RECORD_WAIT_MS;
	while (Date.now() < deadline) {
		const record = readSubagentChildRecords(owner.getEntries()).get(childId);
		if (record && accept(record)) return record;
		await sleep(10);
	}
	throw new Error(
		`child ${childId} never reached the expected record: ${JSON.stringify(readSubagentChildRecords(owner.getEntries()).get(childId))}`,
	);
}

test(
	"a background child released on a budgetless bash wait is reported as released, shows its saved transcript without waking, then wakes and completes without a resume (#5031)",
	async () => {
		initTheme("dark");
		const env = await liveChildEnvironment(cleanups);
		const owner = SessionManager.inMemory(env.root);
		const host = new AgentTaskHost({
			scope: { kind: "session", sessionId: owner.getSessionId() },
			authorizeLaunch() {},
		});
		cleanups.push(() => void host.close("session-close"));
		const parentCommandTaskOwner = createChildCommandTaskOwner(() => host);
		const dispatcher = new AgentWakeDispatcher();
		const base = env.options("build-wait");
		const childOptions = base.getChildSessionOptions;
		assert.ok(childOptions);
		// A wake restores the child with its recorded options: it runs on this test's model, as a real session.
		const withChildOptions = (options: RunSyncOptions): RunSyncOptions => ({
			...options,
			testSession: false,
			getChildSessionOptions: (session) => ({ ...childOptions(session), parentCommandTaskOwner }),
		});
		const events = ownerEvents();
		const pi = {
			events,
			appendEntry: async (customType: string, data?: SubagentChildRecord) =>
				void (await owner.appendCustomEntry(customType, data)),
			getSessionName: () => "parent",
		} as unknown as ExecutorDeps["pi"];
		const ctx = {
			cwd: env.root,
			sessionSignal: new AbortController().signal,
			mode: "tui",
			hasUI: false,
			ui: {},
			sessionManager: owner,
			getAgentTaskHost: () => host,
			modelRegistry: { getAvailable: () => [], getAll: () => [], find: () => undefined },
			model: undefined,
			thinkingLevel: undefined,
		} as unknown as ExtensionContext;
		const runtime = {
			runSync: (...[cwd, agents, name, task, options]: Parameters<typeof runSync>) =>
				runSync(cwd, agents, name, task, withChildOptions(options)),
		};
		const stopWakes = bindReleasedChildWakes(
			{
				pi,
				state: {
					baseCwd: env.root,
					currentSessionId: "parent",
					subagentInProgress: false,
					foregroundControls: new Map(),
					lastForegroundControlId: null,
					pendingForegroundControlNotices: new Map(),
					lastUiContext: null,
				},
				config: {},
				tempArtifactsDir: `${env.root}/artifacts`,
				getSubagentSessionRoot: () => `${env.root}/sessions`,
				expandTilde: (value: string) => value,
				discoverAgents: () => ({ agents: [agent] }),
				runtime,
			} as unknown as Parameters<typeof bindReleasedChildWakes>[0],
			ctx,
			events,
			dispatcher,
		);
		cleanups.push(stopWakes);
		let waitedOn = "";
		env.faux.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall(
						shellTool,
						{ command: shellCommand, wait: { kind: "background" }, timeout: 60 },
						{ id: "sh-1" },
					),
				],
				{ stopReason: "toolUse" },
			),
			// A wait with no budget: the call detaches and the child is released while it runs.
			(context) => {
				waitedOn = shellTaskId(context.messages);
				return fauxAssistantMessage([fauxToolCall(shellTool, { action: "wait", id: waitedOn }, { id: "wait-1" })], {
					stopReason: "toolUse",
				});
			},
			fauxAssistantMessage("The build finished."),
		]);

		const response = await runAgentTask({
			host,
			cwd: env.root,
			agents: [agent],
			agent: "builder",
			task: "build, then wait for the build",
			options: { ...withChildOptions({ ...base, releaseWhenWaiting: subagentReleasePolicy(0) }), index: 0 },
			wakeDispatcher: dispatcher,
			wait: { kind: "background" },
			recordChild: createSubagentChildRecordSink(pi, ctx),
			runtime,
		});
		assert.ok(response.kind === "admitted");
		const childTaskId = response.observation.taskId as TaskId;
		const settled = await host.waitForTask(childTaskId);
		assert.ok(settled.ok && settled.value.kind === "settled", JSON.stringify(settled));
		const result = settled.value.result;
		assert.ok(result.kind === "cancelled");
		assert.deepEqual(result.released?.waitingOn, [{ toolCallId: "wait-1", toolName: shellTool }]);
		assert.equal(subagentTaskResultLabel(result), `released · waiting on ${shellTool} (wait-1)`);
		const notice = formatTaskCompletion(
			{
				completionId: "released-notice",
				ownerId: "owner" as OwnerId,
				taskId: childTaskId,
				terminalSequence: "1" as Sequence,
				result,
				display: false,
			},
			{ kind: "agent", title: "build", agentName: "builder" },
		);
		assert.match(notice, new RegExp(`^Subagent builder released while waiting on ${shellTool} \\(wait-1\\): build`));
		assert.match(notice, /it wakes by itself when that finishes/);
		assert.doesNotMatch(notice, /paused|awaiting resume|resume|Stop reason: pause/);
		const released = await recordUntil(
			owner,
			"build-wait:0",
			(record) => record.terminalStatus === SUBAGENT_CHILD_RELEASED_STATUS,
		);

		// Its transcript reads from its saved session, and reading it does not wake it.
		const lease = host.resolveTask(childTaskId);
		assert.ok(lease.ok);
		const history = await loadTaskOwnTranscriptHistory(lease.value);
		assert.equal(history?.unavailable, undefined, history?.unavailable);
		const messages = (history?.entries ?? []).flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
		assert.ok(
			messages.some(
				(message) => message.role === "user" && JSON.stringify(message.content).includes("wait for the build"),
			),
			"the released child's prompt is shown",
		);
		assert.ok(
			messages.some(
				(message) =>
					message.role === "assistant" &&
					message.content.some((block) => block.type === "toolCall" && block.id === "wait-1"),
			),
			"the call it waits on is shown",
		);
		assert.equal(env.faux.getPendingResponseCount(), 1, "reading the transcript did not run the child");
		const stillReleased = host.resolveTask(childTaskId);
		assert.ok(stillReleased.ok);

		// While it waits, a chat's task footer lists it, beside the shell it waits on.
		const releasedRecord = host.taskRecords().find((record) => record.ref.taskId === childTaskId);
		assert.ok(releasedRecord);
		assert.equal(releasedRecord.wasBackground, true);
		assert.notEqual(releasedRecord.observation.kind, "background", "a released run's observation has ended");
		const footerWhileReleased = stripVTControlCharacters(renderTaskFooter(host.taskRecords(), 100).join("\n"));
		assert.match(footerWhileReleased, new RegExp(`waiting on ${shellTool}`));

		// In /tasks, `x` arms its stop, an unrelated update leaves the stop armed, and the second `x` stops it.
		const cancelled: string[] = [];
		const dismissed: string[] = [];
		const navigation = new TaskNavigation(new KeybindingsManager(), {
			inspect() {},
			openChat() {},
			transcript() {},
			armStop() {},
			cancel: (task) => cancelled.push(task.ref.taskId),
			dismiss: (task) => dismissed.push(task.ref.taskId),
			input() {},
			stdinAvailable: () => false,
			openQuestion() {},
		});
		const listedOrder = () => {
			const listed = withoutSupersededAttempts(host.taskRecords());
			return [
				...listed.filter((task) => task.kind === "agent"),
				...listed.filter((task) => task.kind === "command"),
			].map((task) => task.ref.taskId);
		};
		navigation.update(host.taskRecords(), listedOrder());
		navigation.open(childTaskId);
		navigation.paint(host.taskRecords());
		navigation.handleInput("x", "tasks");
		navigation.update([...host.taskRecords()], listedOrder());
		navigation.handleInput("x", "tasks");
		assert.deepEqual(cancelled, [childTaskId], "the second x stops the waiting child");
		assert.deepEqual(dismissed, []);
		assert.equal(navigation.finishedWhileArmed, undefined, "a waiting child is never reported finished");

		// The build finishes; nobody resumes the child.
		assert.deepEqual(released.waitingOn, [{ toolCallId: "wait-1", toolName: shellTool }]);
		const shellTask = host.resolveTask(waitedOn as TaskId);
		assert.ok(shellTask.ok);
		const input = host.ownerBinding.supervisor.taskStdin(shellTask.value);
		assert.ok(input.ok);
		await host.ownerBinding.supervisor.writeTaskInput(input.value, randomUUID() as OperationId, {
			kind: "bytes",
			bytes: Buffer.from("go\n"),
		});

		const finished = await recordUntil(
			owner,
			"build-wait:0",
			(record) =>
				record.taskId !== childTaskId &&
				record.state === "terminal" &&
				record.terminalStatus !== SUBAGENT_CHILD_RELEASED_STATUS,
		);
		const woken = await host.waitForTask(finished.taskId as TaskId);
		assert.ok(woken.ok && woken.value.kind === "settled");
		assert.equal(woken.value.result.kind, "completed", JSON.stringify(woken.value.result));
		assert.equal(finished.terminalStatus, "ok", "the wake ran the child again on its own, and it finished");
		assert.equal(env.faux.getPendingResponseCount(), 0, "the woken child answered its wait's result");
		// The selection follows the child to the attempt that woke, not to the shell beside it.
		navigation.update(host.taskRecords(), listedOrder());
		assert.equal(navigation.selectedId, finished.taskId);

		// Its released attempt is superseded by the attempt that woke: nothing lists the child as waiting any more.
		const records = host.taskRecords();
		const agents = records.filter((record) => record.kind === "agent");
		assert.ok(agents.some((record) => record.ref.taskId === childTaskId));
		assert.ok(agents.length > 1, "the wake ran as a later attempt of the child");
		const listed = withoutSupersededAttempts(agents);
		assert.deepEqual(
			listed.map((record) => record.ref.taskId),
			[finished.taskId],
		);
		assert.deepEqual(
			taskBoardGroups(listed.map((task) => ({ id: task.ref.taskId, kind: "task" as const, task }))).map(
				(group) => group.title,
			),
			["Done"],
		);
		assert.deepEqual(
			taskPanelItems({ backgroundTasks: records }, new Set(), { topLevelOnly: false })
				.filter((item) => item.state === "waiting")
				.map((item) => item.id),
			[],
		);
		assert.doesNotMatch(stripVTControlCharacters(renderTaskFooter(records, 100).join("\n")), /waiting/);
	},
	LIVE_CHILD_TIMEOUT_MS,
);
