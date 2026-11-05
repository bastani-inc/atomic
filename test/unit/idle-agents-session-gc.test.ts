import assert from "node:assert/strict";
import type { DetachedToolCall, ToolDefinition } from "@bastani/atomic";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/pi-ai/compat";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { afterEach, test } from "vitest";
import { AgentWakeDispatcher } from "../../packages/coding-agent/src/core/agent-wake-dispatcher.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import { AgentTaskHost } from "../../packages/coding-agent/src/core/tasks/agent-adapter.js";
import {
	ChildTaskWaits,
	createChildCommandTaskOwner,
} from "../../packages/coding-agent/src/core/tasks/child-command-owner.js";
import { createHarness } from "../../packages/coding-agent/test/suite/harness.ts";
import { runSingleInProcess } from "../../packages/subagents/src/runs/foreground/inprocess-run-sync.ts";
import {
	forwardDetachedResults,
	subagentReleasePolicy,
	subagentWakeKey,
	subagentWakeNamespace,
} from "../../packages/subagents/src/runs/foreground/released-children.ts";
import { clearSubagentControls } from "../../packages/subagents/src/runs/inprocess/control-registry.ts";
import { collectEverythingTracked, collectGarbage, trackCollection } from "../helpers/collect-garbage.js";
import { liveChildEnvironment } from "../helpers/live-child-environment.js";
import { agent, launchReleasedTask } from "../helpers/released-task-launch.js";
import { trackLastEntry, trackSessions } from "../helpers/track-sessions.js";

const CHILD_LOAD_TIMEOUT_MS = 120_000;
const CHILDREN = 12;
const OWNER_SESSION_ID = "gc-owner";

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length > 0) cleanups.pop()?.();
	clearSubagentControls();
});

test(
	"released subagent children can be collected while their detachable calls are still running (#4326)",
	async () => {
		const tracked = trackCollection();
		cleanups.push(trackSessions(tracked));
		const env = await liveChildEnvironment(cleanups);
		const dispatcher = new AgentWakeDispatcher();
		const woken: string[] = [];
		dispatcher.handle(subagentWakeNamespace(OWNER_SESSION_ID), async (wakeKey) => {
			woken.push(wakeKey);
		});
		const store = new MemorySessionStore();
		for (let index = 0; index < CHILDREN; index++) {
			env.faux.setResponses([
				{
					role: "assistant",
					content: [
						{ type: "toolCall", id: `ci-${index}`, name: "wait_for_ci", arguments: { run: String(index) } },
					],
					stopReason: "toolUse",
				} as never,
			]);
			const result = await runSingleInProcess(env.root, agent, "watch CI", {
				...env.options(`gc-${index}`, {
					sessionManager: await SessionManager.create(store, env.root),
					resumeSession: true,
					releaseWhenWaiting: subagentReleasePolicy(0),
				}),
			});
			assert.equal(result.status, "interrupted");
			assert.ok(result.released, "the child was released while its call is still running");
			forwardDetachedResults(dispatcher, subagentWakeKey(OWNER_SESSION_ID, `gc-${index}:0`), result.released.calls);
		}
		assert.equal(env.answers.length, CHILDREN, "every call is still a live operation");
		await collectEverythingTracked(tracked);
		const stillReachable = tracked.created - tracked.collected();
		for (const answer of env.answers) answer({ content: [{ type: "text", text: "green" }], details: undefined });
		for (let turn = 0; turn < 20 && woken.length < CHILDREN; turn++)
			await new Promise((resolve) => setImmediate(resolve));
		assert.equal(woken.length, CHILDREN, "the live operations were real: each result woke its child");
		assert.deepEqual({ created: tracked.created, stillReachable }, { created: 4 * CHILDREN, stillReachable: 0 });
	},
	CHILD_LOAD_TIMEOUT_MS,
);

async function releaseSdkSession(
	index: number,
	waitTool: ToolDefinition,
	tracked: ReturnType<typeof trackCollection>,
): Promise<DetachedToolCall[]> {
	const harness = await createHarness({
		customTools: [waitTool],
		sessionManager: await SessionManager.create(new MemorySessionStore(), process.cwd()),
	});
	harness.setResponses([
		fauxAssistantMessage([fauxToolCall("wait_for_ci", { run: String(index) }, { id: `ci-${index}` })], {
			stopReason: "toolUse",
		}),
	]);
	harness.session.setToolDetachment({ afterMs: 0 });
	await harness.session.prompt("watch CI");
	const calls = harness.session.takeDetachedToolCalls();
	tracked.track(harness.session);
	tracked.track(harness.sessionManager);
	trackLastEntry(tracked, harness.sessionManager);
	await harness.session.release();
	await harness.cleanup();
	return calls;
}

test(
	"released SDK sessions can be collected while the calls their host holds are still running (#4326)",
	async () => {
		const tracked = trackCollection();
		const answers: Array<(result: AgentToolResult) => void> = [];
		const waitTool: ToolDefinition = {
			name: "wait_for_ci",
			label: "Wait for CI",
			description: "Waits for CI",
			parameters: Type.Object({ run: Type.String() }),
			detachable: true,
			execute: () => new Promise((resolve) => answers.push(resolve)),
		};
		const heldCalls: DetachedToolCall[] = [];
		for (let index = 0; index < CHILDREN; index++)
			heldCalls.push(...(await releaseSdkSession(index, waitTool, tracked)));
		assert.equal(answers.length, CHILDREN, "every call is still a live operation");
		await collectEverythingTracked(tracked);
		const stillReachable = tracked.created - tracked.collected();
		for (const answer of answers) answer({ content: [{ type: "text", text: "green" }], details: undefined });
		const results = await Promise.all(heldCalls.map((call) => call.result));
		assert.equal(results.length, CHILDREN, "the held calls settled with the results the operations gave");
		assert.deepEqual({ created: tracked.created, stillReachable }, { created: 3 * CHILDREN, stillReachable: 0 });
	},
	CHILD_LOAD_TIMEOUT_MS,
);

test(
	"released subagent children launched as tasks can be collected while their calls run: no transcript or route stays behind (#4326)",
	async () => {
		const tracked = trackCollection();
		cleanups.push(trackSessions(tracked));
		const env = await liveChildEnvironment(cleanups);
		const dispatcher = new AgentWakeDispatcher();
		dispatcher.handle(subagentWakeNamespace(OWNER_SESSION_ID), async () => {});
		const owner = SessionManager.inMemory(env.root);
		const host = new AgentTaskHost({
			scope: { kind: "session", sessionId: OWNER_SESSION_ID },
			authorizeLaunch() {},
		});
		cleanups.push(() => void host.close("session-close"));
		for (let index = 0; index < CHILDREN; index++) await launchReleasedTask(index, env, host, owner, dispatcher);
		assert.equal(env.answers.length, CHILDREN, "every call is still a live operation");
		await collectEverythingTracked(tracked);
		assert.deepEqual(
			{ created: tracked.created, stillReachable: tracked.created - tracked.collected() },
			{ created: 4 * CHILDREN, stillReachable: 0 },
		);
	},
	CHILD_LOAD_TIMEOUT_MS,
);

function bindChildRoute(
	owner: ReturnType<typeof createChildCommandTaskOwner>,
	tracked: ReturnType<typeof trackCollection>,
	childId: string,
	unbind: boolean,
): void {
	const child = { childId, history: Array.from({ length: 1_000 }, (_, line) => `${childId} line ${line}`) };
	tracked.track(child);
	owner.bind(childId, { isOpen: () => child.history.length > 0, deliver: async () => {} }, new ChildTaskWaits());
	if (unbind) owner.unbind(childId);
}

test("a child whose route its parent forgot is collected, and one still bound is not: the route is what held it (#4326)", async () => {
	const tracked = trackCollection();
	const host = new AgentTaskHost({ scope: { kind: "session", sessionId: "route-owner" }, authorizeLaunch() {} });
	cleanups.push(() => void host.close("session-close"));
	const owner = createChildCommandTaskOwner(() => host);
	for (let index = 0; index < CHILDREN; index++) bindChildRoute(owner, tracked, `bound-${index}`, false);
	for (let index = 0; index < CHILDREN; index++) bindChildRoute(owner, tracked, `unbound-${index}`, true);
	await collectGarbage();
	assert.deepEqual(
		tracked.uncollected(),
		Array.from({ length: CHILDREN }, (_, index) => index + 1),
		"only the children whose route was never unbound stay reachable",
	);
});
