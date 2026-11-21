import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { ExtensionContext } from "@bastani/atomic";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/atomic-ai/compat";
import { afterEach, test } from "vitest";
import type { AgentSession } from "../../packages/coding-agent/src/core/agent-session.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { AgentTaskHost } from "../../packages/coding-agent/src/core/tasks/agent-adapter.js";
import type { TaskId } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import { isTaskTurnInterrupted, OwnerTaskStore } from "../../packages/coding-agent/src/core/tasks/owner-store.js";
import {
	type TaskTranscriptSource,
	taskTranscriptSource,
} from "../../packages/coding-agent/src/core/tasks/supervisor.js";
import { ownerTaskViewSource } from "../../packages/coding-agent/src/core/tasks/task-view-source.js";
import type { AgentConfig } from "../../packages/subagents/src/agents/agent-types.js";
import { runSync } from "../../packages/subagents/src/runs/foreground/execution.js";
import {
	lateToolResultNotice,
	lateToolResultNoticeKey,
} from "../../packages/subagents/src/runs/foreground/late-tool-result-notice.js";
import { SUBAGENT_CHILD_RECORD_TYPE } from "../../packages/subagents/src/runs/foreground/subagent-child-card-state.js";
import {
	createSubagentChildRecordSink,
	readSubagentChildRecords,
	type SubagentChildRecord,
} from "../../packages/subagents/src/runs/foreground/subagent-child-records.js";
import {
	restoreSubagentChildren,
	SUBAGENT_RESUME_CONTINUATION_PROMPT,
	type SubagentChildRestoreDeps,
} from "../../packages/subagents/src/runs/foreground/subagent-child-restore.js";
import { runAgentTask } from "../../packages/subagents/src/runs/foreground/task-execution.js";
import { clearSubagentControls } from "../../packages/subagents/src/runs/inprocess/control-registry.js";
import type { RunSyncOptions } from "../../packages/subagents/src/shared/types.js";
import { LIVE_CHILD_START_WAIT_MS, liveChildEnvironment } from "../helpers/live-child-environment.js";

/** A live child loads its real resources, twice here (launch and restore): the structural cost of this test. */
const LIVE_RESTORE_TIMEOUT_MS = 180_000;
/** Long enough for a restored child to send a request, had anything prompted it. */
const RESTART_WINDOW_MS = 250;
const CONDITION_WAIT_MS = 20_000;
/** How long the owner's session takes to save a pause, in the test of a slow save. */
const PAUSE_RECORD_DELAY_MS = 400;
/** How long the owner's session takes to save a pause, in the test of what views show meanwhile. */
const SLOW_PAUSE_RECORD_DELAY_MS = 3_000;

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length > 0) cleanups.pop()?.();
	clearSubagentControls();
});

const agent: AgentConfig = {
	name: "worker",
	description: "worker",
	source: "project",
	filePath: "worker.md",
	systemPrompt: "Work",
	systemPromptMode: "replace",
	inheritProjectContext: false,
	inheritSkills: false,
};

async function until(predicate: () => boolean, timeoutMs = CONDITION_WAIT_MS): Promise<void> {
	const deadline = performance.now() + timeoutMs;
	while (!predicate() && performance.now() < deadline) await new Promise<void>((resolve) => setTimeout(resolve, 5));
	assert.ok(predicate(), "condition never held");
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function taskHost(name: string): AgentTaskHost {
	return new AgentTaskHost({ scope: { kind: "session", sessionId: `${name}-${randomUUID()}` }, authorizeLaunch() {} });
}

/**
 * The parent session the child records are written to, as the subagents extension writes them. `beforeAppend` runs
 * before each record is written, and the record is dropped when it answers `false`, as when the process is gone.
 */
function parentSession(
	cwd: string,
	options: { beforeAppend?: (data: SubagentChildRecord | undefined) => Promise<boolean> } = {},
) {
	const sessionManager = SessionManager.inMemory(cwd);
	const pi = {
		events: { on: () => () => {}, emit() {} },
		appendEntry: async (customType: string, data?: SubagentChildRecord) => {
			if (options.beforeAppend !== undefined && !(await options.beforeAppend(data))) return;
			await sessionManager.appendCustomEntry(customType, data);
		},
		getSessionName: () => "parent-session",
	} as unknown as SubagentChildRestoreDeps["pi"];
	const ctx = (host: AgentTaskHost) =>
		({
			cwd,
			sessionManager,
			getAgentTaskHost: () => host,
			modelRegistry: { getAvailable: () => [], getAll: () => [], find: () => undefined },
			model: undefined,
			thinkingLevel: undefined,
		}) as unknown as ExtensionContext;
	const latest = (childId: string) => readSubagentChildRecords(sessionManager.getEntries()).get(childId);
	return { sessionManager, pi, ctx, latest };
}

function transcriptOf(host: AgentTaskHost, taskId: string): TaskTranscriptSource | undefined {
	const lease = host.resolveTask(taskId as TaskId);
	const bound = lease.ok ? taskTranscriptSource(lease.value) : undefined;
	return bound?.ok ? bound.value.session : undefined;
}

/** The texts of the context the model was given after its last answer: what reached it this turn. */
function newInput(context: { messages: ReadonlyArray<{ role: string; content: unknown }> }): string {
	const messages = context.messages;
	let start = messages.length;
	while (start > 0 && messages[start - 1]!.role !== "assistant") start--;
	return messages
		.slice(start)
		.map((message) => JSON.stringify(message.content))
		.join("\n");
}

test(
	"a subagent paused with Esc comes back paused after a restart: no request and no continuation prompt, another agent's message stays held, and the reader's send continues it with exactly that text",
	async () => {
		const env = await liveChildEnvironment(cleanups);
		env.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("block", {}, { id: "block-before-restart" })], { stopReason: "toolUse" }),
		]);
		const parent = parentSession(env.root);
		const runId = "esc-pause-restore";
		const childId = `${runId}:0`;
		const liveOptions = env.options(runId);
		// The relaunch runs a real session on the faux model, as the launch did.
		const launchOptions = (options: RunSyncOptions): RunSyncOptions => ({
			...options,
			testSession: false,
			getChildSessionOptions: liveOptions.getChildSessionOptions,
		});

		// Before the restart: the child works in a tool, and the reader pauses it.
		const before = taskHost("before-restart");
		const launched = await runAgentTask({
			host: before,
			cwd: env.root,
			agents: [agent],
			agent: "worker",
			task: "run until paused",
			options: { ...liveOptions, index: 0, sessionDir: join(env.root, "children", runId) },
			recordChild: createSubagentChildRecordSink(parent.pi, parent.ctx(before)),
			runtime: { runSync: (...args) => runSync(args[0], args[1], args[2], args[3], launchOptions(args[4])) },
		});
		assert.equal(launched.kind, "admitted");
		const firstTask = launched.kind === "admitted" ? launched.observation.taskId : "";
		await until(() => env.blockStarted() && transcriptOf(before, firstTask) !== undefined, LIVE_CHILD_START_WAIT_MS);
		await transcriptOf(before, firstTask)!.pauseTurn!();
		await until(() => parent.latest(childId)?.pausedByUser === true);
		const requestsBeforeRestart = env.faux.state.callCount;

		// The engine goes away with the child paused: its record is all that is left.
		await before.close("session-close");
		await until(() => parent.latest(childId)?.state === "running" && parent.latest(childId)?.pausedByUser === true);

		// After the restart, session recovery restores it.
		const inputs: string[] = [];
		env.faux.setResponses([
			(context) => {
				inputs.push(newInput(context));
				return fauxAssistantMessage("answered after the restart");
			},
		]);
		const after = taskHost("after-restart");
		const store = new OwnerTaskStore(after.ownerBinding.supervisor, after.ownerBinding.owner);
		try {
			const deps: SubagentChildRestoreDeps = {
				pi: parent.pi,
				config: {},
				discoverAgents: () => ({ agents: [agent] }),
				runtime: { runSync: (...args) => runSync(args[0], args[1], args[2], args[3], launchOptions(args[4])) },
			};
			const [outcome] = await restoreSubagentChildren(deps, parent.ctx(after));
			assert.equal(outcome?.kind, "restored");
			const restoredTask = outcome?.kind === "restored" ? outcome.taskId : "";
			await until(() => transcriptOf(after, restoredTask)?.turnPaused?.() === true);
			const source = transcriptOf(after, restoredTask)!;
			const session = source.chatSession as unknown as AgentSession;
			assert.ok(store.connect().ok);

			await pause(RESTART_WINDOW_MS);
			assert.equal(env.faux.state.callCount, requestsBeforeRestart, "nothing prompted the restored child");
			assert.equal(source.isRunning?.(), false);
			assert.equal(
				JSON.stringify(source.getEntries()).includes(SUBAGENT_RESUME_CONTINUATION_PROMPT),
				false,
				"it is not told to continue on its own",
			);
			store.drain();
			const shown = store.getTask(restoredTask as TaskId);
			assert.ok(
				shown !== undefined && isTaskTurnInterrupted(shown),
				"/tasks, the panel and the header show it paused",
			);
			assert.equal(parent.latest(childId)?.pausedByUser, true);

			// Another agent's message is held while it is paused.
			await session.sendCustomMessage(
				{ customType: "intercom", content: "peer note while paused", display: true },
				{ triggerTurn: true },
			);
			await pause(RESTART_WINDOW_MS);
			assert.equal(env.faux.state.callCount, requestsBeforeRestart, "another agent's message does not continue it");

			// The reader's send continues it, with that text first and the held message after it.
			await source.resumeTurn!();
			await session.prompt("carry on after the restart", { streamingBehavior: "steer" });
			await after.waitForTask(restoredTask as TaskId);
			await until(() => inputs.length > 0);
			const delivered = inputs.join("\n");
			assert.ok(delivered.indexOf("carry on after the restart") >= 0, "the reader's text is what it receives");
			assert.ok(delivered.indexOf("peer note while paused") > delivered.indexOf("carry on after the restart"));
			assert.equal(delivered.includes(SUBAGENT_RESUME_CONTINUATION_PROMPT), false);
			await until(() => parent.latest(childId)?.pausedByUser === false);
		} finally {
			store.dispose();
			await after.close("session-close");
		}
	},
	LIVE_RESTORE_TIMEOUT_MS,
);

test(
	"a subagent running when Atomic restarted is continued after the restart by a note, never a message from the user, in one request",
	async () => {
		const env = await liveChildEnvironment(cleanups);
		env.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("block", {}, { id: "block-before-restart" })], { stopReason: "toolUse" }),
		]);
		const parent = parentSession(env.root);
		const runId = "restart-note";
		const childId = `${runId}:0`;
		const liveOptions = env.options(runId);
		const launchOptions = (options: RunSyncOptions): RunSyncOptions => ({
			...options,
			testSession: false,
			getChildSessionOptions: liveOptions.getChildSessionOptions,
		});
		const before = taskHost("before-restart");
		const launched = await runAgentTask({
			host: before,
			cwd: env.root,
			agents: [agent],
			agent: "worker",
			task: "run until Atomic stops",
			options: { ...liveOptions, index: 0, sessionDir: join(env.root, "children", runId) },
			recordChild: createSubagentChildRecordSink(parent.pi, parent.ctx(before)),
			runtime: { runSync: (...args) => runSync(args[0], args[1], args[2], args[3], launchOptions(args[4])) },
		});
		assert.equal(launched.kind, "admitted");
		const firstTask = launched.kind === "admitted" ? launched.observation.taskId : "";
		await until(() => env.blockStarted() && transcriptOf(before, firstTask) !== undefined, LIVE_CHILD_START_WAIT_MS);
		await before.close("session-close");
		await until(() => parent.latest(childId)?.state === "running");

		const inputs: string[] = [];
		env.faux.setResponses([
			(context) => {
				inputs.push(newInput(context));
				return fauxAssistantMessage("continued after the restart");
			},
		]);
		const after = taskHost("after-restart");
		try {
			const deps: SubagentChildRestoreDeps = {
				pi: parent.pi,
				config: {},
				discoverAgents: () => ({ agents: [agent] }),
				runtime: { runSync: (...args) => runSync(args[0], args[1], args[2], args[3], launchOptions(args[4])) },
			};
			const [outcome] = await restoreSubagentChildren(deps, parent.ctx(after));
			assert.equal(outcome?.kind, "restored");
			const restoredTask = outcome?.kind === "restored" ? outcome.taskId : "";
			await after.waitForTask(restoredTask as TaskId);
			await until(() => inputs.length > 0);
			await pause(RESTART_WINDOW_MS);

			assert.equal(inputs.length, 1, "one request continues it");
			assert.equal(inputs[0]?.split("Atomic restarted while you were working").length - 1, 1, "told once");
			const record = parent.latest(childId);
			assert.ok(record?.childSessionFile);
			const entries = (await SessionManager.open(record.childSessionFile, undefined, record.cwd)).getBranch();
			const continuations = entries.filter(
				(entry) =>
					entry.type === "message" &&
					entry.message.role === "user" &&
					JSON.stringify(entry.message.content).includes("Atomic restarted while you were working"),
			);
			assert.deepEqual(continuations, [], "no message from the user tells it");
			assert.ok(
				entries.some((entry) => entry.type === "custom_message" && entry.customType === "subagent-resume-note"),
				"its chat shows the note",
			);
		} finally {
			await after.close("session-close");
		}
	},
	LIVE_RESTORE_TIMEOUT_MS,
);

test(
	"a subagent paused before it read a late result's notice comes back paused after a restart: the notice starts no request, and the reader's send reads it once",
	async () => {
		const env = await liveChildEnvironment(cleanups);
		env.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("block", {}, { id: "block-before-restart" })], { stopReason: "toolUse" }),
		]);
		const parent = parentSession(env.root);
		const runId = "esc-pause-late";
		const childId = `${runId}:0`;
		const liveOptions = env.options(runId);
		const launchOptions = (options: RunSyncOptions): RunSyncOptions => ({
			...options,
			testSession: false,
			getChildSessionOptions: liveOptions.getChildSessionOptions,
		});

		// Before the restart: the reader pauses the child, and a late result's notice reaches it unread.
		const before = taskHost("before-restart");
		const launched = await runAgentTask({
			host: before,
			cwd: env.root,
			agents: [agent],
			agent: "worker",
			task: "run until paused",
			options: { ...liveOptions, index: 0, sessionDir: join(env.root, "children", runId) },
			recordChild: createSubagentChildRecordSink(parent.pi, parent.ctx(before)),
			runtime: { runSync: (...args) => runSync(args[0], args[1], args[2], args[3], launchOptions(args[4])) },
		});
		assert.equal(launched.kind, "admitted");
		const firstTask = launched.kind === "admitted" ? launched.observation.taskId : "";
		await until(() => env.blockStarted() && transcriptOf(before, firstTask) !== undefined, LIVE_CHILD_START_WAIT_MS);
		const beforeSource = transcriptOf(before, firstTask)!;
		await beforeSource.pauseTurn!();
		await until(() => parent.latest(childId)?.pausedByUser === true);
		const late = {
			toolCallId: "ci-late",
			toolName: "wait_for_ci",
			result: { content: [{ type: "text" as const, text: "CI green while paused" }], details: undefined },
			isError: false,
		};
		await (beforeSource.chatSession as unknown as AgentSession).sendCustomMessage(lateToolResultNotice([late]), {
			triggerTurn: true,
			persistWhenStreaming: true,
			stageAdmissionKey: lateToolResultNoticeKey([late]),
		});
		const requestsBeforeRestart = env.faux.state.callCount;
		await before.close("session-close");
		await until(() => parent.latest(childId)?.state === "running" && parent.latest(childId)?.pausedByUser === true);

		const inputs: string[] = [];
		env.faux.setResponses([
			(context) => {
				inputs.push(newInput(context));
				return fauxAssistantMessage("answered after the restart");
			},
		]);
		const after = taskHost("after-restart");
		try {
			const deps: SubagentChildRestoreDeps = {
				pi: parent.pi,
				config: {},
				discoverAgents: () => ({ agents: [agent] }),
				runtime: { runSync: (...args) => runSync(args[0], args[1], args[2], args[3], launchOptions(args[4])) },
			};
			const [outcome] = await restoreSubagentChildren(deps, parent.ctx(after));
			assert.equal(outcome?.kind, "restored");
			const restoredTask = outcome?.kind === "restored" ? outcome.taskId : "";
			await until(() => transcriptOf(after, restoredTask)?.turnPaused?.() === true);
			const source = transcriptOf(after, restoredTask)!;
			const session = source.chatSession as unknown as AgentSession;

			await pause(RESTART_WINDOW_MS);
			assert.equal(
				env.faux.state.callCount,
				requestsBeforeRestart,
				"the unread notice does not run the paused child",
			);
			assert.equal(source.isRunning?.(), false);

			await source.resumeTurn!();
			await session.prompt("carry on after the restart", { streamingBehavior: "steer" });
			await after.waitForTask(restoredTask as TaskId);
			await until(() => inputs.length > 0);
			assert.equal(inputs.length, 1, "one request reads both");
			const delivered = inputs.join("\n");
			assert.ok(delivered.includes("carry on after the restart"), "the reader's text is what continues it");
			assert.equal(delivered.split("CI green while paused").length - 1, 1, "the result is read once");
		} finally {
			await after.close("session-close");
		}
	},
	LIVE_RESTORE_TIMEOUT_MS,
);

test(
	"a pause an older version continued after a restart is not restored paused: the message that continued the subagent ends it",
	async () => {
		const env = await liveChildEnvironment(cleanups);
		env.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("block", {}, { id: "block-before-downgrade" })], { stopReason: "toolUse" }),
		]);
		const parent = parentSession(env.root);
		const runId = "esc-pause-downgrade";
		const childId = `${runId}:0`;
		const liveOptions = env.options(runId);
		const launchOptions = (options: RunSyncOptions): RunSyncOptions => ({
			...options,
			testSession: false,
			getChildSessionOptions: liveOptions.getChildSessionOptions,
		});

		// This version: the reader pauses the working child, and Atomic closes.
		const before = taskHost("before-downgrade");
		const launched = await runAgentTask({
			host: before,
			cwd: env.root,
			agents: [agent],
			agent: "worker",
			task: "run until paused",
			options: { ...liveOptions, index: 0, sessionDir: join(env.root, "children", runId) },
			recordChild: createSubagentChildRecordSink(parent.pi, parent.ctx(before)),
			runtime: { runSync: (...args) => runSync(args[0], args[1], args[2], args[3], launchOptions(args[4])) },
		});
		assert.equal(launched.kind, "admitted");
		const firstTask = launched.kind === "admitted" ? launched.observation.taskId : "";
		await until(() => env.blockStarted() && transcriptOf(before, firstTask) !== undefined, LIVE_CHILD_START_WAIT_MS);
		await transcriptOf(before, firstTask)!.pauseTurn!();
		await until(() => parent.latest(childId)?.pausedByUser === true);
		await before.close("session-close");
		await until(() => parent.latest(childId)?.state === "running");
		const paused = parent.latest(childId)!;
		assert.ok(paused.childSessionFile !== undefined, "the child's session is saved in a file");

		// An older version restores it as it restores any running child: it continues it with the continuation prompt,
		// and the record it writes says nothing of pauses, so the pause written before stays in the merged record.
		const child = await SessionManager.open(paused.childSessionFile, undefined, paused.cwd);
		await child.appendMessage({ role: "user", content: SUBAGENT_RESUME_CONTINUATION_PROMPT, timestamp: Date.now() });
		await child.appendMessage(fauxAssistantMessage("continued by the older version"));
		const { pausedByUser: _pausedByUser, pausedAtLeafId: _pausedAtLeafId, ...older } = paused;
		await parent.pi.appendEntry(SUBAGENT_CHILD_RECORD_TYPE, { ...older, taskId: "older-version-task" });
		assert.equal(parent.latest(childId)?.pausedByUser, true, "the older version's record keeps the pause behind");

		// This version again: the child is restored as it is restored without a pause, continued with the prompt.
		const inputs: string[] = [];
		env.faux.setResponses([
			(context) => {
				inputs.push(newInput(context));
				return fauxAssistantMessage("answered after the upgrade");
			},
		]);
		const after = taskHost("after-upgrade");
		try {
			const deps: SubagentChildRestoreDeps = {
				pi: parent.pi,
				config: {},
				discoverAgents: () => ({ agents: [agent] }),
				runtime: { runSync: (...args) => runSync(args[0], args[1], args[2], args[3], launchOptions(args[4])) },
			};
			const [outcome] = await restoreSubagentChildren(deps, parent.ctx(after));
			assert.equal(outcome?.kind, "restored");
			const restoredTask = outcome?.kind === "restored" ? outcome.taskId : "";
			await until(() => inputs.length > 0);
			assert.ok(inputs[0]?.includes(SUBAGENT_RESUME_CONTINUATION_PROMPT), "it is continued, as a running child is");
			assert.notEqual(transcriptOf(after, restoredTask)?.turnPaused?.(), true);
			await until(() => parent.latest(childId)?.pausedByUser === false);
		} finally {
			await after.close("session-close");
		}
	},
	LIVE_RESTORE_TIMEOUT_MS,
);

test(
	"a pause recorded by a build that names no leaf entry is still restored paused: nothing prompts the subagent",
	async () => {
		const env = await liveChildEnvironment(cleanups);
		env.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("block", {}, { id: "block-before-leafless-restart" })], {
				stopReason: "toolUse",
			}),
		]);
		const parent = parentSession(env.root);
		const runId = "esc-pause-leafless";
		const childId = `${runId}:0`;
		const liveOptions = env.options(runId);
		const launchOptions = (options: RunSyncOptions): RunSyncOptions => ({
			...options,
			testSession: false,
			getChildSessionOptions: liveOptions.getChildSessionOptions,
		});

		// Its records are written as a build that recorded pauses without their leaf entry wrote them.
		const before = taskHost("before-leafless-restart");
		const sink = createSubagentChildRecordSink(parent.pi, parent.ctx(before));
		const launched = await runAgentTask({
			host: before,
			cwd: env.root,
			agents: [agent],
			agent: "worker",
			task: "run until paused",
			options: { ...liveOptions, index: 0, sessionDir: join(env.root, "children", runId) },
			recordChild: {
				...sink,
				record: (record) => {
					const { pausedAtLeafId: _pausedAtLeafId, ...leafless } = record;
					return sink.record(leafless);
				},
			},
			runtime: { runSync: (...args) => runSync(args[0], args[1], args[2], args[3], launchOptions(args[4])) },
		});
		assert.equal(launched.kind, "admitted");
		const firstTask = launched.kind === "admitted" ? launched.observation.taskId : "";
		await until(() => env.blockStarted() && transcriptOf(before, firstTask) !== undefined, LIVE_CHILD_START_WAIT_MS);
		await transcriptOf(before, firstTask)!.pauseTurn!();
		await until(() => parent.latest(childId)?.pausedByUser === true);
		await before.close("session-close");
		await until(() => parent.latest(childId)?.state === "running");
		assert.equal(parent.latest(childId)?.pausedAtLeafId, undefined, "the record names no leaf entry");
		const requestsBeforeRestart = env.faux.state.callCount;

		const after = taskHost("after-leafless-restart");
		try {
			const deps: SubagentChildRestoreDeps = {
				pi: parent.pi,
				config: {},
				discoverAgents: () => ({ agents: [agent] }),
				runtime: { runSync: (...args) => runSync(args[0], args[1], args[2], args[3], launchOptions(args[4])) },
			};
			const [outcome] = await restoreSubagentChildren(deps, parent.ctx(after));
			assert.equal(outcome?.kind, "restored");
			const restoredTask = outcome?.kind === "restored" ? outcome.taskId : "";
			await until(() => transcriptOf(after, restoredTask)?.turnPaused?.() === true);
			await pause(RESTART_WINDOW_MS);
			assert.equal(env.faux.state.callCount, requestsBeforeRestart, "nothing prompted the restored subagent");
			assert.equal(
				JSON.stringify(transcriptOf(after, restoredTask)!.getEntries()).includes(
					SUBAGENT_RESUME_CONTINUATION_PROMPT,
				),
				false,
				"it is not told to continue on its own",
			);
			assert.equal(parent.latest(childId)?.pausedByUser, true);
		} finally {
			await after.close("session-close");
		}
	},
	LIVE_RESTORE_TIMEOUT_MS,
);

test(
	"Esc's pause is shown once its record is saved: a crash right after it restores the subagent paused",
	async () => {
		const env = await liveChildEnvironment(cleanups);
		env.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("block", {}, { id: "block-before-slow-record" })], {
				stopReason: "toolUse",
			}),
		]);
		/** Set when the process dies: nothing it still had to write reaches its session. */
		let gone = false;
		// The owner's session is slow to save the pause.
		const parent = parentSession(env.root, {
			beforeAppend: async (record) => {
				if (record?.pausedByUser === true) await pause(PAUSE_RECORD_DELAY_MS);
				return !gone;
			},
		});
		const runId = "esc-pause-slow-record";
		const childId = `${runId}:0`;
		const liveOptions = env.options(runId);
		const launchOptions = (options: RunSyncOptions): RunSyncOptions => ({
			...options,
			testSession: false,
			getChildSessionOptions: liveOptions.getChildSessionOptions,
		});
		const before = taskHost("before-slow-record");
		const launched = await runAgentTask({
			host: before,
			cwd: env.root,
			agents: [agent],
			agent: "worker",
			task: "run until paused",
			options: { ...liveOptions, index: 0, sessionDir: join(env.root, "children", runId) },
			recordChild: createSubagentChildRecordSink(parent.pi, parent.ctx(before)),
			runtime: { runSync: (...args) => runSync(args[0], args[1], args[2], args[3], launchOptions(args[4])) },
		});
		assert.equal(launched.kind, "admitted");
		const firstTask = launched.kind === "admitted" ? launched.observation.taskId : "";
		await until(() => env.blockStarted() && transcriptOf(before, firstTask) !== undefined, LIVE_CHILD_START_WAIT_MS);
		const requestsBeforeRestart = env.faux.state.callCount;

		await transcriptOf(before, firstTask)!.pauseTurn!();
		assert.equal(parent.latest(childId)?.pausedByUser, true, "the pause is saved by the time it is shown");
		// The process dies right after the chat showed the pause.
		gone = true;
		await before.close("session-close");
		gone = false;

		const after = taskHost("after-slow-record");
		try {
			const deps: SubagentChildRestoreDeps = {
				pi: parent.pi,
				config: {},
				discoverAgents: () => ({ agents: [agent] }),
				runtime: { runSync: (...args) => runSync(args[0], args[1], args[2], args[3], launchOptions(args[4])) },
			};
			const [outcome] = await restoreSubagentChildren(deps, parent.ctx(after));
			assert.equal(outcome?.kind, "restored");
			const restoredTask = outcome?.kind === "restored" ? outcome.taskId : "";
			await until(() => transcriptOf(after, restoredTask)?.turnPaused?.() === true);
			await pause(RESTART_WINDOW_MS);
			assert.equal(env.faux.state.callCount, requestsBeforeRestart, "nothing prompted the restored subagent");
		} finally {
			await after.close("session-close");
		}
	},
	LIVE_RESTORE_TIMEOUT_MS,
);

test(
	"a pause whose record cannot be saved is still shown, with the warning that a restart continues the subagent",
	async () => {
		const env = await liveChildEnvironment(cleanups);
		env.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("block", {}, { id: "block-before-unsaved-pause" })], {
				stopReason: "toolUse",
			}),
		]);
		// The owner's session cannot save the pause.
		const parent = parentSession(env.root, {
			beforeAppend: async (record) => {
				if (record?.pausedByUser === true) throw new Error("the session store is read-only");
				return true;
			},
		});
		const runId = "esc-pause-unsaved";
		const liveOptions = env.options(runId);
		const before = taskHost("unsaved-pause");
		try {
			const launched = await runAgentTask({
				host: before,
				cwd: env.root,
				agents: [agent],
				agent: "worker",
				task: "run until paused",
				options: { ...liveOptions, index: 0, sessionDir: join(env.root, "children", runId) },
				recordChild: createSubagentChildRecordSink(parent.pi, parent.ctx(before)),
				runtime: {
					runSync: (...args) =>
						runSync(args[0], args[1], args[2], args[3], {
							...args[4],
							testSession: false,
							getChildSessionOptions: liveOptions.getChildSessionOptions,
						}),
				},
			});
			assert.equal(launched.kind, "admitted");
			const firstTask = launched.kind === "admitted" ? launched.observation.taskId : "";
			await until(
				() => env.blockStarted() && transcriptOf(before, firstTask) !== undefined,
				LIVE_CHILD_START_WAIT_MS,
			);
			const paused = await transcriptOf(before, firstTask)!.pauseTurn!();
			assert.match(paused.warning ?? "", /pause was not saved: if Atomic restarts, it continues/);
			assert.equal(transcriptOf(before, firstTask)!.turnPaused?.(), true, "it is paused all the same");
		} finally {
			await before.close("session-close");
		}
	},
	LIVE_RESTORE_TIMEOUT_MS,
);

test(
	"a pause recorded without its leaf entry that an older version continued is restored continued, as one never paused",
	async () => {
		const env = await liveChildEnvironment(cleanups);
		env.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("block", {}, { id: "block-before-leafless-downgrade" })], {
				stopReason: "toolUse",
			}),
		]);
		const parent = parentSession(env.root);
		const runId = "esc-pause-leafless-downgrade";
		const childId = `${runId}:0`;
		const liveOptions = env.options(runId);
		const launchOptions = (options: RunSyncOptions): RunSyncOptions => ({
			...options,
			testSession: false,
			getChildSessionOptions: liveOptions.getChildSessionOptions,
		});

		// A build that recorded pauses without their leaf entry pauses the child, and Atomic closes.
		const before = taskHost("before-leafless-downgrade");
		const sink = createSubagentChildRecordSink(parent.pi, parent.ctx(before));
		const launched = await runAgentTask({
			host: before,
			cwd: env.root,
			agents: [agent],
			agent: "worker",
			task: "run until paused",
			options: { ...liveOptions, index: 0, sessionDir: join(env.root, "children", runId) },
			recordChild: {
				...sink,
				record: (record) => {
					const { pausedAtLeafId: _pausedAtLeafId, ...leafless } = record;
					return sink.record(leafless);
				},
			},
			runtime: { runSync: (...args) => runSync(args[0], args[1], args[2], args[3], launchOptions(args[4])) },
		});
		assert.equal(launched.kind, "admitted");
		const firstTask = launched.kind === "admitted" ? launched.observation.taskId : "";
		await until(() => env.blockStarted() && transcriptOf(before, firstTask) !== undefined, LIVE_CHILD_START_WAIT_MS);
		await transcriptOf(before, firstTask)!.pauseTurn!();
		await until(() => parent.latest(childId)?.pausedByUser === true);
		await before.close("session-close");
		await until(() => parent.latest(childId)?.state === "running");
		const paused = parent.latest(childId)!;
		assert.equal(paused.pausedAtLeafId, undefined, "the record names no leaf entry");
		assert.ok(paused.childSessionFile !== undefined);

		// An older version restores and continues it; its record says nothing of pauses.
		await pause(5);
		const child = await SessionManager.open(paused.childSessionFile, undefined, paused.cwd);
		await child.appendMessage({ role: "user", content: SUBAGENT_RESUME_CONTINUATION_PROMPT, timestamp: Date.now() });
		await child.appendMessage(fauxAssistantMessage("continued by the older version"));
		const { pausedByUser: _pausedByUser, ...older } = paused;
		await parent.pi.appendEntry(SUBAGENT_CHILD_RECORD_TYPE, { ...older, taskId: "older-version-task" });
		assert.equal(parent.latest(childId)?.pausedByUser, true, "the older version's record keeps the pause behind");

		const inputs: string[] = [];
		env.faux.setResponses([
			(context) => {
				inputs.push(newInput(context));
				return fauxAssistantMessage("answered after the upgrade");
			},
		]);
		const after = taskHost("after-leafless-downgrade");
		try {
			const deps: SubagentChildRestoreDeps = {
				pi: parent.pi,
				config: {},
				discoverAgents: () => ({ agents: [agent] }),
				runtime: { runSync: (...args) => runSync(args[0], args[1], args[2], args[3], launchOptions(args[4])) },
			};
			const [outcome] = await restoreSubagentChildren(deps, parent.ctx(after));
			assert.equal(outcome?.kind, "restored");
			await until(() => inputs.length > 0);
			assert.ok(inputs[0]?.includes(SUBAGENT_RESUME_CONTINUATION_PROMPT), "it is continued, as a running child is");
		} finally {
			await after.close("session-close");
		}
	},
	LIVE_RESTORE_TIMEOUT_MS,
);

test(
	"a pause recorded without its leaf entry that an older version continued and kept writing as paused is restored continued",
	async () => {
		const env = await liveChildEnvironment(cleanups);
		env.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("block", {}, { id: "block-before-merged-downgrade" })], {
				stopReason: "toolUse",
			}),
		]);
		const parent = parentSession(env.root);
		const runId = "esc-pause-merged-downgrade";
		const childId = `${runId}:0`;
		const liveOptions = env.options(runId);
		const launchOptions = (options: RunSyncOptions): RunSyncOptions => ({
			...options,
			testSession: false,
			getChildSessionOptions: liveOptions.getChildSessionOptions,
		});

		// A build that recorded pauses without their leaf entry pauses the child, and Atomic closes.
		const before = taskHost("before-merged-downgrade");
		const sink = createSubagentChildRecordSink(parent.pi, parent.ctx(before));
		const launched = await runAgentTask({
			host: before,
			cwd: env.root,
			agents: [agent],
			agent: "worker",
			task: "run until paused",
			options: { ...liveOptions, index: 0, sessionDir: join(env.root, "children", runId) },
			recordChild: {
				...sink,
				record: (record) => {
					const { pausedAtLeafId: _pausedAtLeafId, ...leafless } = record;
					return sink.record(leafless);
				},
			},
			runtime: { runSync: (...args) => runSync(args[0], args[1], args[2], args[3], launchOptions(args[4])) },
		});
		assert.equal(launched.kind, "admitted");
		const firstTask = launched.kind === "admitted" ? launched.observation.taskId : "";
		await until(() => env.blockStarted() && transcriptOf(before, firstTask) !== undefined, LIVE_CHILD_START_WAIT_MS);
		await transcriptOf(before, firstTask)!.pauseTurn!();
		await until(() => parent.latest(childId)?.pausedByUser === true);
		await before.close("session-close");
		await until(() => parent.latest(childId)?.state === "running");
		const paused = parent.latest(childId)!;
		assert.equal(paused.pausedAtLeafId, undefined, "the record names no leaf entry");
		assert.ok(paused.childSessionFile !== undefined);

		// An older version continues it, then writes whole merged records, which still say paused.
		await pause(5);
		const child = await SessionManager.open(paused.childSessionFile, undefined, paused.cwd);
		await child.appendMessage({ role: "user", content: SUBAGENT_RESUME_CONTINUATION_PROMPT, timestamp: Date.now() });
		await child.appendMessage(fauxAssistantMessage("continued by the older version"));
		await pause(5);
		await parent.pi.appendEntry(SUBAGENT_CHILD_RECORD_TYPE, { ...paused, taskId: "older-version-task" });
		await parent.pi.appendEntry(SUBAGENT_CHILD_RECORD_TYPE, {
			...paused,
			taskId: "older-version-task",
			elapsedMs: 5,
		});

		const inputs: string[] = [];
		env.faux.setResponses([
			(context) => {
				inputs.push(newInput(context));
				return fauxAssistantMessage("answered after the upgrade");
			},
		]);
		const after = taskHost("after-merged-downgrade");
		try {
			const deps: SubagentChildRestoreDeps = {
				pi: parent.pi,
				config: {},
				discoverAgents: () => ({ agents: [agent] }),
				runtime: { runSync: (...args) => runSync(args[0], args[1], args[2], args[3], launchOptions(args[4])) },
			};
			const [outcome] = await restoreSubagentChildren(deps, parent.ctx(after));
			assert.equal(outcome?.kind, "restored");
			await until(() => inputs.length > 0);
			assert.ok(inputs[0]?.includes(SUBAGENT_RESUME_CONTINUATION_PROMPT), "it is continued, as a running child is");
		} finally {
			await after.close("session-close");
		}
	},
	LIVE_RESTORE_TIMEOUT_MS,
);

test(
	"nothing shows a subagent paused before its pause is saved: not its session's answer, not /tasks",
	async () => {
		const env = await liveChildEnvironment(cleanups);
		env.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("block", {}, { id: "block-before-slow-save" })], { stopReason: "toolUse" }),
		]);
		const parent = parentSession(env.root, {
			beforeAppend: async (record) => {
				if (record?.pausedByUser === true) await pause(SLOW_PAUSE_RECORD_DELAY_MS);
				return true;
			},
		});
		const runId = "esc-pause-slow-save";
		const childId = `${runId}:0`;
		const liveOptions = env.options(runId);
		const host = taskHost("slow-save");
		const store = new OwnerTaskStore(host.ownerBinding.supervisor, host.ownerBinding.owner);
		try {
			assert.ok(store.connect().ok);
			const launched = await runAgentTask({
				host,
				cwd: env.root,
				agents: [agent],
				agent: "worker",
				task: "run until paused",
				options: { ...liveOptions, index: 0, sessionDir: join(env.root, "children", runId) },
				recordChild: createSubagentChildRecordSink(parent.pi, parent.ctx(host)),
				runtime: {
					runSync: (...args) =>
						runSync(args[0], args[1], args[2], args[3], {
							...args[4],
							testSession: false,
							getChildSessionOptions: liveOptions.getChildSessionOptions,
						}),
				},
			});
			assert.equal(launched.kind, "admitted");
			const task = launched.kind === "admitted" ? launched.observation.taskId : "";
			await until(() => env.blockStarted() && transcriptOf(host, task) !== undefined, LIVE_CHILD_START_WAIT_MS);
			const source = transcriptOf(host, task)!;
			// Esc in its chat pauses it through the task view, which /tasks and the chat read.
			const view = ownerTaskViewSource(store);
			let answered = false;
			const pausing = view.pauseTask!(task as TaskId).then((result) => {
				assert.ok(result.ok);
				answered = true;
			});
			// While the pause is being saved, nothing says paused.
			const deadline = performance.now() + SLOW_PAUSE_RECORD_DELAY_MS / 2;
			while (performance.now() < deadline) {
				store.drain();
				const shown = store.getTask(task as TaskId);
				assert.equal(source.turnPaused?.(), false, "its session's answer waits for the saved pause");
				assert.ok(shown === undefined || !isTaskTurnInterrupted(shown), "/tasks waits for the saved pause");
				assert.equal(answered, false);
				await pause(50);
			}
			await pausing;
			assert.equal(parent.latest(childId)?.pausedByUser, true);
			assert.equal(source.turnPaused?.(), true, "once saved, it is paused");
			await until(() => {
				store.drain();
				const shown = store.getTask(task as TaskId);
				return shown !== undefined && isTaskTurnInterrupted(shown);
			});
		} finally {
			store.dispose();
			await host.close("session-close");
		}
	},
	LIVE_RESTORE_TIMEOUT_MS,
);

test(
	"a second Esc while the first pause is still being saved waits for that save too: nothing shows paused before it",
	async () => {
		const env = await liveChildEnvironment(cleanups);
		env.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("block", {}, { id: "block-before-second-esc" })], {
				stopReason: "toolUse",
			}),
		]);
		const parent = parentSession(env.root, {
			beforeAppend: async (record) => {
				if (record?.pausedByUser === true) await pause(SLOW_PAUSE_RECORD_DELAY_MS);
				return true;
			},
		});
		const runId = "esc-pause-second-esc";
		const childId = `${runId}:0`;
		const liveOptions = env.options(runId);
		const host = taskHost("second-esc");
		const store = new OwnerTaskStore(host.ownerBinding.supervisor, host.ownerBinding.owner);
		try {
			assert.ok(store.connect().ok);
			const launched = await runAgentTask({
				host,
				cwd: env.root,
				agents: [agent],
				agent: "worker",
				task: "run until paused",
				options: { ...liveOptions, index: 0, sessionDir: join(env.root, "children", runId) },
				recordChild: createSubagentChildRecordSink(parent.pi, parent.ctx(host)),
				runtime: {
					runSync: (...args) =>
						runSync(args[0], args[1], args[2], args[3], {
							...args[4],
							testSession: false,
							getChildSessionOptions: liveOptions.getChildSessionOptions,
						}),
				},
			});
			assert.equal(launched.kind, "admitted");
			const task = launched.kind === "admitted" ? launched.observation.taskId : "";
			await until(() => env.blockStarted() && transcriptOf(host, task) !== undefined, LIVE_CHILD_START_WAIT_MS);
			const source = transcriptOf(host, task)!;
			const view = ownerTaskViewSource(store);
			let answered = 0;
			const first = view.pauseTask!(task as TaskId).then(() => {
				answered++;
			});
			// The reader presses Esc again a moment later, while the first pause is still being saved.
			await pause(3);
			const second = source.pauseTurn!().then(() => {
				answered++;
			});
			const deadline = performance.now() + SLOW_PAUSE_RECORD_DELAY_MS / 2;
			while (performance.now() < deadline) {
				store.drain();
				const shown = store.getTask(task as TaskId);
				assert.equal(source.turnPaused?.(), false, "its session's answer waits for the saved pause");
				assert.ok(shown === undefined || !isTaskTurnInterrupted(shown), "/tasks waits for the saved pause");
				assert.equal(answered, 0, "neither Esc is answered before the pause is saved");
				await pause(50);
			}
			await Promise.all([first, second]);
			assert.equal(parent.latest(childId)?.pausedByUser, true);
			assert.equal(source.turnPaused?.(), true, "once saved, it is paused");
		} finally {
			store.dispose();
			await host.close("session-close");
		}
	},
	LIVE_RESTORE_TIMEOUT_MS,
);
