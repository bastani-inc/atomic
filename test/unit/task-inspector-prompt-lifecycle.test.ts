import assert from "node:assert/strict";
import { test } from "vitest";
import type { AgentSession } from "../../packages/coding-agent/src/core/agent-session.js";
import type { AgentSessionRuntime } from "../../packages/coding-agent/src/core/agent-session-runtime.js";
import { createEventBus } from "../../packages/coding-agent/src/core/event-bus.js";
import {
	createExtensionRuntime,
	loadExtensionFromFactory,
} from "../../packages/coding-agent/src/core/extensions/loader.js";
import { ExtensionRunner } from "../../packages/coding-agent/src/core/extensions/runner.js";
import { noOpUIContext } from "../../packages/coding-agent/src/core/extensions/runner-ui.js";
import type { ExtensionUIContext } from "../../packages/coding-agent/src/core/extensions/types.js";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import { bindOwnerTaskStore } from "../../packages/coding-agent/src/core/tasks/owner-store.js";
import { deriveSessionActivity } from "../../packages/coding-agent/src/extensions/herdr/activity.js";
import { createRpcCommandHandler } from "../../packages/coding-agent/src/modes/rpc/rpc-command-handler.js";
import { taskFixture } from "../helpers/task-projection.js";

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test("isolated /tasks is navigation, while genuine custom approvals still report blocked", async () => {
	const fixture = taskFixture();
	const runtime = createExtensionRuntime();
	const events: string[] = [];
	let openPromptCount = 0;
	const extension = await loadExtensionFromFactory(
		(pi) => {
			pi.on("ui_prompt_start", () => {
				openPromptCount++;
				events.push("start");
			});
			pi.on("ui_prompt_end", () => {
				openPromptCount--;
				events.push("end");
			});
		},
		process.cwd(),
		createEventBus(),
		runtime,
		"prompt-observer",
	);
	const runner = new ExtensionRunner([extension], runtime, process.cwd(), {} as never, {} as never);
	let close = () => {};
	const rawUi = {
		...noOpUIContext,
		custom: (() =>
			new Promise<void>((resolve) => {
				close = resolve;
			})) as ExtensionUIContext["custom"],
	};
	runner.setUIContext(rawUi, "tui");
	const session = { extensionRunner: runner, getAgentTaskHost() {} } as unknown as AgentSession;
	bindOwnerTaskStore(session, fixture.store);
	const handler = createRpcCommandHandler({
		runtimeHost: {} as AgentSessionRuntime,
		getSession: () => session,
		rebindSession: async () => {},
		output: () => {},
		keybindings: new KeybindingsManager(),
		...{ taskInspectorUi: rawUi },
	});
	const state = (agentRunning: boolean) => deriveSessionActivity({ agentRunning, openPromptCount }).state;
	try {
		await handler({ type: "open_task_inspector" });
		await flush();
		assert.deepEqual(events, [], "browsing tasks must not emit an approval span");
		assert.equal(state(false), "idle");
		assert.equal(state(true), "working");
		close();
		await flush();
		assert.deepEqual(events, []);
		const approval = runner.getUIContext().custom(() => ({ render: () => [], invalidate() {} }));
		await flush();
		assert.equal(state(false), "blocked");
		assert.equal(state(true), "blocked");
		close();
		await approval;
		await flush();
		assert.deepEqual(events, ["start", "end"]);
		assert.equal(state(false), "idle");
	} finally {
		close();
		await flush();
		runner.invalidate();
		await fixture.dispose();
	}
});
