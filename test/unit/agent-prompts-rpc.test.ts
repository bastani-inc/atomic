import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import type { AgentSession } from "../../packages/coding-agent/src/core/agent-session.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import type { TaskId } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import { bindOwnerTaskStore } from "../../packages/coding-agent/src/core/tasks/owner-store.js";
import { ownerTaskViewSource } from "../../packages/coding-agent/src/core/tasks/task-view-source.js";
import {
	localAgentPrompts,
	remoteAgentPrompts,
} from "../../packages/coding-agent/src/modes/interactive/agent-view/agent-prompts.js";
import { bindEngineAgentView } from "../../packages/coding-agent/src/modes/rpc/agent-view-rpc.js";
import { createEngineHostPair } from "../../packages/coding-agent/test/helpers/in-process-engine-pair.js";
import { taskFixture } from "../helpers/task-projection.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	while (cleanups.length) await cleanups.pop()?.();
});

/** A running subagent of `fixture` whose session holds its task and one message typed to it. */
async function subagent(fixture: ReturnType<typeof taskFixture>): Promise<TaskId> {
	await fixture.start("trace the loader");
	const session = SessionManager.inMemory();
	// Bound as a runner binds it, before the subagent's first prompt.
	fixture.runners.at(-1)!.context.bindTranscript(Object.assign(session, { subscribe: () => () => {} }));
	await session.appendMessage({ role: "user", content: "trace the loader", timestamp: 0 });
	await session.appendMessage({ role: "user", content: "and the cache", timestamp: 1 });
	return fixture.store.tasks.at(-1)!.ref.taskId;
}

test("a subagent shown in this process has its prompts read from its own session", async () => {
	const fixture = taskFixture();
	cleanups.push(() => fixture.dispose());
	const taskId = await subagent(fixture);
	assert.deepEqual(await localAgentPrompts(ownerTaskViewSource(fixture.store), taskId), [
		"trace the loader",
		"and the cache",
	]);
});

test("the host reads a subagent's prompts from the isolated engine that runs it, and none when the engine cannot answer", async () => {
	const pair = await createEngineHostPair({});
	cleanups.push(() => pair.cleanup());
	const fixture = taskFixture();
	cleanups.push(() => fixture.dispose());
	const taskId = await subagent(fixture);
	const engineSession = pair.engine.session as AgentSession;
	bindOwnerTaskStore(engineSession, fixture.store);
	cleanups.push(
		bindEngineAgentView({ session: engineSession, send: () => {}, customUi: {} as never, ui: {} as never }),
	);

	assert.deepEqual(await remoteAgentPrompts(pair.runtime, taskId), ["trace the loader", "and the cache"]);
	assert.deepEqual(await remoteAgentPrompts(pair.runtime, "task-unknown" as TaskId), []);
	pair.failCommand("get_task_prompts", "engine busy");
	assert.deepEqual(await remoteAgentPrompts(pair.runtime, taskId), []);
});
