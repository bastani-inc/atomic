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
import type { AgentConfig } from "../../packages/subagents/src/agents/agent-types.js";
import { runSync } from "../../packages/subagents/src/runs/foreground/execution.js";
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

/** The parent session the child records are written to, as the subagents extension writes them. */
function parentSession(cwd: string) {
	const sessionManager = SessionManager.inMemory(cwd);
	const pi = {
		events: { on: () => () => {}, emit() {} },
		appendEntry: async (customType: string, data?: SubagentChildRecord) => {
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
