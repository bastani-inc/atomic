import assert from "node:assert/strict";
import type { DetachedToolCall, ToolDefinition } from "@bastani/atomic";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/pi-ai/compat";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { afterEach, test } from "vitest";
import { AgentWakeDispatcher } from "../../packages/coding-agent/src/core/agent-wake-dispatcher.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import { createHarness } from "../../packages/coding-agent/test/suite/harness.ts";
import type { AgentConfig } from "../../packages/subagents/src/agents/agent-types.ts";
import { runSingleInProcess } from "../../packages/subagents/src/runs/foreground/inprocess-run-sync.ts";
import {
	subagentReleasePolicy,
	subagentWakeNamespace,
} from "../../packages/subagents/src/runs/foreground/released-children.ts";
import { clearSubagentControls } from "../../packages/subagents/src/runs/inprocess/control-registry.ts";
import { collectGarbage, trackCollection } from "../helpers/collect-garbage.js";
import { liveChildEnvironment } from "../helpers/live-child-environment.js";
import { trackSessions } from "../helpers/track-sessions.js";

const CHILD_LOAD_TIMEOUT_MS = 120_000;
const CHILDREN = 12;
const OWNER_SESSION_ID = "gc-owner";

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
					releaseWhenWaiting: subagentReleasePolicy(OWNER_SESSION_ID, `gc-${index}:0`, dispatcher, 0),
				}),
			});
			assert.equal(result.status, "interrupted");
			assert.ok(result.released, "the child was released while its call is still running");
		}
		assert.equal(env.answers.length, CHILDREN, "every call is still a live operation");
		await collectGarbage();
		const stillReachable = tracked.created - tracked.collected();
		for (const answer of env.answers) answer({ content: [{ type: "text", text: "green" }], details: undefined });
		for (let turn = 0; turn < 20 && woken.length < CHILDREN; turn++)
			await new Promise((resolve) => setImmediate(resolve));
		assert.equal(woken.length, CHILDREN, "the live operations were real: each result woke its child");
		assert.deepEqual({ created: tracked.created, stillReachable }, { created: 2 * CHILDREN, stillReachable: 0 });
	},
	CHILD_LOAD_TIMEOUT_MS,
);

async function releaseSdkSession(
	index: number,
	waitTool: ToolDefinition,
	tracked: ReturnType<typeof trackCollection>,
): Promise<DetachedToolCall[]> {
	const harness = await createHarness({ customTools: [waitTool] });
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
		await collectGarbage();
		const stillReachable = tracked.created - tracked.collected();
		for (const answer of answers) answer({ content: [{ type: "text", text: "green" }], details: undefined });
		const results = await Promise.all(heldCalls.map((call) => call.result));
		assert.equal(results.length, CHILDREN, "the held calls settled with the results the operations gave");
		assert.deepEqual({ created: tracked.created, stillReachable }, { created: 2 * CHILDREN, stillReachable: 0 });
	},
	CHILD_LOAD_TIMEOUT_MS,
);
