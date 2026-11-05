import assert from "node:assert/strict";
import type { DetachedToolResult } from "@bastani/atomic";
import { fauxAssistantMessage, fauxToolCall, registerSessionResourceCleanup } from "@bastani/pi-ai/compat";
import { afterEach, test } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import type { Cleanup } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import type { AgentConfig } from "../../packages/subagents/src/agents/agent-types.ts";
import { runSingleInProcess } from "../../packages/subagents/src/runs/foreground/inprocess-run-sync.ts";
import { clearSubagentControls } from "../../packages/subagents/src/runs/inprocess/control-registry.ts";
import type { TaskExecutionHooks } from "../../packages/subagents/src/shared/types.ts";
import { liveChildEnvironment } from "../helpers/live-child-environment.js";

const LIVE_CHILD_TIMEOUT_MS = 120_000;

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

const waitCall = () =>
	fauxAssistantMessage([fauxToolCall("wait_for_ci", { run: "7" }, { id: "ci-1" })], { stopReason: "toolUse" });

function taskHooks(overrides: Partial<TaskExecutionHooks> = {}): TaskExecutionHooks {
	const pending: Array<Promise<Cleanup>> = [];
	return {
		signal: new AbortController().signal,
		reportActivity() {},
		onExecution(execution) {
			pending.push(execution.cleanup);
		},
		yieldTaskWait() {},
		isParentObserving: () => false,
		...overrides,
	};
}

test(
	"a child released with a message queued and unread hands it back with its release (#4326)",
	async () => {
		const env = await liveChildEnvironment(cleanups);
		env.faux.setResponses([waitCall()]);
		const released = await runSingleInProcess(env.root, agent, "watch CI", {
			...env.options("release-queued", {
				sessionManager: await SessionManager.create(new MemorySessionStore(), env.root),
				resumeSession: true,
				resumeFollowUps: ["Check the flaky test too."],
				releaseWhenWaiting: { afterMs: 0 },
			}),
		});
		assert.equal(released.status, "interrupted");
		assert.ok(released.released);
		assert.deepEqual(released.pendingMessages, ["Check the flaky test too."]);
		assert.equal(released.pendingTaskExpands, undefined);
	},
	LIVE_CHILD_TIMEOUT_MS,
);

test(
	"a released child's session has closed before its release returns, so a result settled while it closed wakes it at once into a closed session (#4326)",
	async () => {
		const env = await liveChildEnvironment(cleanups);
		const store = new MemorySessionStore();
		const childSession = await SessionManager.create(store, env.root);
		const order: string[] = [];
		cleanups.push(
			registerSessionResourceCleanup((sessionId) => {
				if (sessionId !== childSession.getSessionId() || order.includes("result")) return;
				order.push("result");
				env.answers[0]?.({ content: [{ type: "text", text: "green" }], details: undefined });
			}),
		);
		env.faux.setResponses([waitCall()]);

		const released = await runSingleInProcess(env.root, agent, "watch CI", {
			...env.options("release-closed", {
				sessionManager: childSession,
				resumeSession: true,
				releaseWhenWaiting: { afterMs: 0 },
				taskExecution: taskHooks({ clearExtensionStatuses: () => void order.push("closed") }),
			}),
		});
		order.push("released");

		assert.deepEqual(order, ["result", "closed", "released"]);
		const [call] = released.released?.calls ?? [];
		assert.ok(call);
		const result: DetachedToolResult = await call.result;
		assert.equal(result.isError, false);
		env.faux.setResponses([fauxAssistantMessage("CI is green; done.")]);
		const woken = await runSingleInProcess(env.root, agent, "watch CI", {
			...env.options("release-closed", {
				sessionManager: await SessionManager.open(store, childSession.getSessionId()),
				resumeSession: true,
				resumeToolResults: [result],
				skipTaskPrompt: true,
				taskExecution: taskHooks(),
			}),
		});
		assert.equal(woken.status, "ok");
		assert.equal(woken.finalOutput, "CI is green; done.");
	},
	LIVE_CHILD_TIMEOUT_MS,
);

test(
	"a woken child's results count as delivered only once its session has saved them (#4326)",
	async () => {
		const env = await liveChildEnvironment(cleanups);
		const store = new MemorySessionStore();
		const childSession = await SessionManager.create(store, env.root);
		env.faux.setResponses([waitCall()]);
		const released = await runSingleInProcess(env.root, agent, "watch CI", {
			...env.options("release-saved", {
				sessionManager: childSession,
				resumeSession: true,
				releaseWhenWaiting: { afterMs: 0 },
			}),
		});
		assert.ok(released.released);
		const green: DetachedToolResult = {
			toolCallId: "ci-1",
			toolName: "wait_for_ci",
			result: { content: [{ type: "text", text: "green" }], details: undefined },
			isError: false,
		};
		const saved: Array<{ ids: readonly string[]; answered: Promise<boolean> }> = [];
		env.faux.setResponses([fauxAssistantMessage("CI is green; done.")]);
		const woken = await runSingleInProcess(env.root, agent, "watch CI", {
			...env.options("release-saved", {
				sessionManager: await SessionManager.open(store, childSession.getSessionId()),
				resumeSession: true,
				resumeToolResults: [green],
				skipTaskPrompt: true,
				taskExecution: taskHooks({
					toolResultsSaved: (ids) =>
						void saved.push({
							ids,
							answered: store
								.load(childSession.getSessionId())
								.then((snapshot) =>
									snapshot.entries.some(
										(entry) =>
											entry.type === "message" &&
											entry.message.role === "toolResult" &&
											entry.message.toolCallId === "ci-1",
									),
								),
						}),
				}),
			}),
		});

		assert.equal(woken.status, "ok");
		assert.deepEqual(
			saved.map((entry) => entry.ids),
			[["ci-1"]],
		);
		assert.equal(await saved[0]?.answered, true, "the session holds the call's result when it is reported saved");
	},
	LIVE_CHILD_TIMEOUT_MS,
);

test(
	"a child reopened after its owner restarted starts its detached call again under the same id and is released again without a model request (#4326)",
	async () => {
		const env = await liveChildEnvironment(cleanups);
		const store = new MemorySessionStore();
		const childSession = await SessionManager.create(store, env.root);
		env.faux.setResponses([waitCall()]);
		const released = await runSingleInProcess(env.root, agent, "watch CI", {
			...env.options("release-redispatch", {
				sessionManager: childSession,
				resumeSession: true,
				releaseWhenWaiting: { afterMs: 0 },
			}),
		});
		assert.ok(released.released);
		assert.equal(env.answers.length, 1);
		const roles = async () =>
			(await SessionManager.open(store, childSession.getSessionId()))
				.buildSessionProjection()
				.messages.map((message) => message.role)
				.filter((role) => role !== "system");
		const before = await roles();
		env.faux.setResponses([fauxAssistantMessage("never requested")]);

		const again = await runSingleInProcess(env.root, agent, "unused", {
			...env.options("release-redispatch", {
				sessionManager: await SessionManager.open(store, childSession.getSessionId()),
				resumeSession: true,
				releaseWhenWaiting: { afterMs: 0 },
				redispatchDetachedCalls: true,
				resumeFollowUps: ["Check the flaky test too."],
				resumeTaskLiteral: true,
			}),
		});

		assert.equal(again.status, "interrupted");
		assert.deepEqual(again.released?.waitingOn, [{ toolCallId: "ci-1", toolName: "wait_for_ci" }]);
		assert.equal(env.answers.length, 2, "the call ran again");
		assert.equal(env.faux.getPendingResponseCount(), 1, "no model request was made");
		assert.deepEqual(await roles(), before, "nothing was added to the transcript");
		assert.deepEqual(again.pendingMessages, ["Check the flaky test too."], "held messages are kept for its wake");
		env.answers[1]?.({ content: [{ type: "text", text: "green" }], details: undefined });
		const [call] = again.released?.calls ?? [];
		assert.ok(call);
		const result: DetachedToolResult = await call.result;
		assert.deepEqual(
			[result.toolCallId, result.isError, result.result.content],
			["ci-1", false, [{ type: "text", text: "green" }]],
		);
	},
	LIVE_CHILD_TIMEOUT_MS,
);
