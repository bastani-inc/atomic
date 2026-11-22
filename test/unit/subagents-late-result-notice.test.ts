import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@bastani/atomic";
import { type Context, fauxAssistantMessage, fauxToolCall } from "@bastani/atomic-ai/compat";
import { afterEach, test } from "vitest";
import { AgentWakeDispatcher } from "../../packages/coding-agent/src/core/agent-wake-dispatcher.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { AgentTaskHost } from "../../packages/coding-agent/src/core/tasks/agent-adapter.js";
import type { TaskId } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import type { AgentConfig } from "../../packages/subagents/src/agents/agent-types.ts";
import { SUBAGENT_SUPERVISOR_AUTHORIZATION_EVENT } from "../../packages/subagents/src/intercom/supervisor-authorization.js";
import { runSync } from "../../packages/subagents/src/runs/foreground/execution.js";
import {
	lateToolResultNoticeKey,
	renderLateToolResultNotice,
	SUBAGENT_LATE_TOOL_RESULT_TYPE,
} from "../../packages/subagents/src/runs/foreground/late-tool-result-notice.js";
import { bindReleasedChildWakes } from "../../packages/subagents/src/runs/foreground/released-child-wakes.js";
import {
	subagentReleasePolicy,
	subagentWakeKey,
} from "../../packages/subagents/src/runs/foreground/released-children.js";
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
import { runAgentTask } from "../../packages/subagents/src/runs/foreground/task-execution.js";
import { clearSubagentControls } from "../../packages/subagents/src/runs/inprocess/control-registry.ts";
import type { RunSyncOptions } from "../../packages/subagents/src/shared/types.ts";
import { liveChildEnvironment } from "../helpers/live-child-environment.js";
import { sleep } from "../helpers/runtime.js";
import { stripVTControlCharacters } from "../helpers/visible-text.ts";

/** A live child loads its real resources and is woken twice; that is the structural cost of this test. */
const LIVE_CHILD_TIMEOUT_MS = 120_000;
const RECORD_WAIT_MS = 30_000;
const CI_OUTPUT = "CI green: 42 passed";

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length > 0) cleanups.pop()?.();
	clearSubagentControls();
});

const agent: AgentConfig = {
	name: "waiter",
	description: "waits on CI",
	systemPrompt: "",
	systemPromptMode: "replace",
	inheritProjectContext: false,
	inheritSkills: false,
	source: "user",
	filePath: "/tmp/waiter.md",
};

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

/** The text of a provider message, its text parts joined. */
function textOf(message: Context["messages"][number]): string {
	return typeof message.content === "string"
		? message.content
		: message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}

test(
	"a result that arrives after its call was answered as still running reaches the woken child as a notice it reads once, never as a queued message from the user",
	async () => {
		initTheme("dark");
		const env = await liveChildEnvironment(cleanups);
		const owner = SessionManager.inMemory(env.root);
		const host = new AgentTaskHost({
			scope: { kind: "session", sessionId: owner.getSessionId() },
			authorizeLaunch() {},
		});
		cleanups.push(() => void host.close("session-close"));
		const dispatcher = new AgentWakeDispatcher();
		const base = env.options("late-notice");
		const childOptions = base.getChildSessionOptions;
		assert.ok(childOptions);
		// A wake restores the child with its recorded options: it runs on this test's model, as a real session.
		const withChildOptions = (options: RunSyncOptions): RunSyncOptions => ({
			...options,
			testSession: false,
			getChildSessionOptions: childOptions,
		});
		const events = ownerEvents();
		const atomic = {
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
				pi: atomic,
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
		const lateRequests: Context["messages"][] = [];
		env.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("wait_for_ci", { run: "7" }, { id: "ci-1" })], { stopReason: "toolUse" }),
			// Woken by something else first: its call is answered as still running, and it finishes for now.
			fauxAssistantMessage("CI is still running; I will read its result when it arrives."),
			(context) => {
				lateRequests.push(context.messages);
				return fauxAssistantMessage("CI is green; done.");
			},
		]);

		const response = await runAgentTask({
			host,
			cwd: env.root,
			agents: [agent],
			agent: "waiter",
			task: "watch CI",
			options: { ...withChildOptions({ ...base, releaseWhenWaiting: subagentReleasePolicy(0) }), index: 0 },
			wakeDispatcher: dispatcher,
			recordChild: createSubagentChildRecordSink(atomic, ctx),
			runtime,
		});
		assert.ok(response.kind === "admitted");
		const released = await recordUntil(
			owner,
			"late-notice:0",
			(record) => record.terminalStatus === SUBAGENT_CHILD_RELEASED_STATUS,
		);
		const wakeKey = subagentWakeKey(owner.getSessionId(), "late-notice:0");
		await dispatcher.deliver(wakeKey, { id: "timer:first", kind: "timer" });
		const finished = await recordUntil(
			owner,
			"late-notice:0",
			(record) => record.taskId !== released.taskId && record.state === "terminal" && record.terminalStatus === "ok",
		);
		assert.equal(env.faux.getPendingResponseCount(), 1, "the first wake answered its call as still running");

		// The call's result arrives after its call was answered.
		env.answers[0]?.({ content: [{ type: "text", text: CI_OUTPUT }], details: undefined });
		const woken = await recordUntil(
			owner,
			"late-notice:0",
			(record) => record.taskId !== finished.taskId && record.state === "terminal" && record.terminalStatus === "ok",
		);
		assert.ok(woken.taskId);
		await host.waitForTask(woken.taskId as TaskId);
		await dispatcher.whenIdle();

		assert.equal(env.faux.getPendingResponseCount(), 0, "the late result started the child's turn");
		assert.equal(lateRequests.length, 1, "one request reads it");
		const request = lateRequests[0] ?? [];
		const reads = request.filter((message) => textOf(message).includes(CI_OUTPUT));
		assert.equal(reads.length, 1, "the model reads the result once");
		assert.match(textOf(reads[0]!), /^Your wait_for_ci call that kept running in the background finished\./);
		assert.doesNotMatch(textOf(reads[0]!), /ci-1/, "the notice names no call id");
		assert.deepEqual(woken.heldToolResults ?? [], [], "the owner lets the result go once the child read it");

		assert.ok(woken.childSessionFile);
		const transcript = await SessionManager.open(woken.childSessionFile, undefined, woken.cwd);
		const entries = transcript.getBranch();
		assert.deepEqual(
			entries.flatMap((entry) =>
				entry.type === "message" && entry.message.role === "user" ? [textOf(entry.message)] : [],
			),
			["watch CI"],
			"no message from the user brings the result",
		);
		const notices = entries.filter(
			(entry) => entry.type === "custom_message" && entry.customType === SUBAGENT_LATE_TOOL_RESULT_TYPE,
		);
		assert.equal(notices.length, 1, "one notice, shown in its chat");
		const notice = notices[0];
		assert.ok(notice?.type === "custom_message");
		assert.equal(notice.display, true);
		const card = (expanded: boolean) =>
			stripVTControlCharacters(renderLateToolResultNotice(notice, { expanded })?.render(80).join("\n") ?? "");
		assert.match(card(false), /● wait_for_ci finished in the background/);
		assert.doesNotMatch(card(false), /ci-1|toolu_|Follow-up/);
		assert.match(card(true), new RegExp(CI_OUTPUT));
	},
	LIVE_CHILD_TIMEOUT_MS,
);

test("a late result notice's admission key is the same for the same results, and differs for any other result of a call id (#3274)", () => {
	const late = (text: string, isError = false) => ({
		toolCallId: "functions.bash:0",
		toolName: "bash",
		result: { content: [{ type: "text" as const, text }], details: undefined },
		isError,
	});
	const issuedBy = (entryId: string) => new Map([["functions.bash:0", entryId]]);
	const key = lateToolResultNoticeKey([late("exit 0")], issuedBy("entry-1"));
	// Saved again, after a restart, it adds nothing.
	assert.equal(lateToolResultNoticeKey([late("exit 0")], issuedBy("entry-1")), key);
	// A later call's result is another notice: issued by another entry, even with the same output, or with other output.
	assert.notEqual(lateToolResultNoticeKey([late("exit 0")], issuedBy("entry-2")), key);
	assert.notEqual(lateToolResultNoticeKey([late("exit 1")], issuedBy("entry-1")), key);
	assert.notEqual(lateToolResultNoticeKey([late("exit 0", true)], issuedBy("entry-1")), key);
});
