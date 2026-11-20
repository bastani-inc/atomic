import assert from "node:assert/strict";
import { afterEach, describe, test, vi } from "vitest";
import type { PromptDisposition } from "../src/core/agent-session-types.js";
import type { TaskId } from "../src/core/tasks/contracts.js";
import {
	type AgentViewRuntime,
	createRemoteAgentSteering,
} from "../src/modes/interactive/agent-view/agent-steering.ts";
import type { AgentViewStatus } from "../src/modes/interactive/agent-view/contracts.ts";
import { SteeringQueueController } from "../src/modes/interactive/steering-queue-controller.ts";
import type { EngineAgentViewContext } from "../src/modes/rpc/agent-view-rpc.ts";
import {
	handleAgentViewClearQueue,
	handleAgentViewPause,
	handleAgentViewPrompt,
	handleAgentViewResume,
} from "../src/modes/rpc/agent-view-rpc-prompt.ts";
import type { AgentViewRpcCommandBody } from "../src/modes/rpc/agent-view-rpc-types.ts";
import { assertRpcSuccess } from "../src/modes/rpc/rpc-error-decoding.ts";
import type { RpcResponse } from "../src/modes/rpc/rpc-types.ts";
import { FakeAgentViewPort } from "./helpers/fake-agent-view-port.ts";

/** The views the engine has open for the host, by view id: fake ports the test drives. */
const views = vi.hoisted(() => ({ ports: new Map<string, unknown>() }));
vi.mock("../src/modes/rpc/agent-view-rpc-view.ts", () => ({
	engineAgentViews: () => ({ port: (viewId: string) => views.ports.get(viewId) }),
	bindEngineAgentViews: () => () => {},
	handleAgentViewOpen: async () => undefined,
	handleAgentViewClose: async () => undefined,
	handleAgentViewLastMessage: async () => undefined,
}));

const VIEW = "view-1";
const context = { session: {} } as EngineAgentViewContext;

afterEach(() => views.ports.clear());

/** The engine side of the host's agent-view commands, answered as the RPC client answers the host. */
async function engineAnswer(command: AgentViewRpcCommandBody): Promise<unknown> {
	let response: RpcResponse;
	switch (command.type) {
		case "agent_view_prompt":
			response = await handleAgentViewPrompt(command, context);
			break;
		case "agent_view_resume":
			response = await handleAgentViewResume(command, context);
			break;
		case "agent_view_clear_queue":
			response = await handleAgentViewClearQueue(command, context);
			break;
		case "agent_view_pause":
			response = await handleAgentViewPause(command, context);
			break;
		default:
			throw new Error(`unexpected ${command.type}`);
	}
	assertRpcSuccess(response);
	return "data" in response ? response.data : undefined;
}

/** The host's steering of the subagent the engine shows in view `VIEW`, over that engine. */
function hostSteering(port: FakeAgentViewPort) {
	views.ports.set(VIEW, port);
	const sent: AgentViewRpcCommandBody[] = [];
	const runtime = {
		requestAgentView: async <T>(command: AgentViewRpcCommandBody): Promise<T> => {
			sent.push(command);
			return (await engineAnswer(command)) as T;
		},
	} as unknown as AgentViewRuntime;
	let status: AgentViewStatus = port.status();
	const listeners = new Set<() => void>();
	port.subscribe(() => {
		// The engine's status events reach the host after the engine's own state changed.
		status = port.status();
		for (const listener of listeners) listener();
	});
	const steering = createRemoteAgentSteering({
		runtime,
		viewId: VIEW,
		status: () => status,
		onStatus: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	});
	return { steering, sent };
}

function controllerOver(port: FakeAgentViewPort) {
	const host = hostSteering(port);
	const controller = new SteeringQueueController(host.steering.steering, {
		held: () => [],
		takeHeld: () => ({ messages: [], putBack: () => {} }),
		changed: () => {},
		requestRender: () => {},
	});
	return { ...host, controller };
}

describe("steering a subagent the isolated engine shows on the host's screen", () => {
	test("a steer and a follow-up typed while it works reach its session in their lanes, and stay rows until it lists them", async () => {
		const port = new FakeAgentViewPort({ taskId: "task-1" as TaskId, busy: true });
		const { controller, sent } = controllerOver(port);
		const steer = controller.submit("check the tests", "auto");
		assert.deepEqual(controller.allQueued(), { steering: ["check the tests"], followUp: [] });
		assert.deepEqual(await steer, { kind: "queued" });
		const followUp = await controller.submit("then summarize", "followUp");
		assert.deepEqual(followUp, { kind: "queued" });
		assert.deepEqual(port.calls, [
			{ kind: "prompt", text: "check the tests", lane: "steer" },
			{ kind: "prompt", text: "then summarize", lane: "followUp" },
		]);
		assert.deepEqual(
			sent.map((command) => command.type),
			["agent_view_prompt", "agent_view_prompt"],
		);
		port.setStatus({ queued: { steering: ["check the tests"], followUp: ["then summarize"] } });
		assert.deepEqual(controller.allQueued(), { steering: ["check the tests"], followUp: ["then summarize"] });
	});

	test("its session's answer settles the row as in the main chat: a message that started a turn is no longer queued", async () => {
		const port = new FakeAgentViewPort({ taskId: "task-1" as TaskId, busy: true });
		let disposition: PromptDisposition = "started";
		port.promptAnswer = async (_text, options) => options?.preflightResult?.(true, disposition);
		const { controller } = controllerOver(port);
		assert.deepEqual(await controller.submit("go", "auto"), { kind: "started" });
		assert.deepEqual(controller.allQueued(), { steering: [], followUp: [] });
		disposition = "handled";
		assert.deepEqual(await controller.submit("/skill:review", "auto"), { kind: "handled" });
	});

	test("a paused subagent is continued with the message, which is its next one", async () => {
		const port = new FakeAgentViewPort({ taskId: "task-1" as TaskId, paused: true });
		const { controller, sent } = controllerOver(port);
		assert.deepEqual(await controller.submit("carry on", "auto"), { kind: "started" });
		assert.deepEqual(port.calls, [{ kind: "resume", text: "carry on", lane: "auto" }]);
		assert.deepEqual(sent, [{ type: "agent_view_resume", viewId: VIEW, message: "carry on", lane: "auto" }]);
	});

	test("Alt+Up takes the queue back from its session's own answer, steering first", async () => {
		const port = new FakeAgentViewPort({
			taskId: "task-1" as TaskId,
			busy: true,
			queued: { steering: ["s1", "s2"], followUp: ["f1"] },
		});
		const { controller } = controllerOver(port);
		const restored = await controller.restoreAll(() => "draft");
		assert.deepEqual(restored, { messages: ["s1", "s2", "f1"], text: "s1\n\ns2\n\nf1\n\ndraft" });
	});

	test("Esc's pause answers what came back from its queue", async () => {
		const port = new FakeAgentViewPort({ taskId: "task-1" as TaskId, busy: true });
		port.pauseAnswer = { ok: true, value: { steering: ["s1"], followUp: ["f1"] } };
		const { steering, sent } = hostSteering(port);
		assert.deepEqual(await steering.pause(), { ok: true, value: { steering: ["s1"], followUp: ["f1"] } });
		assert.deepEqual(sent, [{ type: "agent_view_pause", viewId: VIEW }]);
	});

	test("a message its session refuses comes back to the host as refused, with the reason", async () => {
		const port = new FakeAgentViewPort({ taskId: "task-1" as TaskId });
		port.promptAnswer = async () => {
			throw new Error("The agent did not take the message");
		};
		const { controller } = controllerOver(port);
		const result = await controller.submit("hello", "auto");
		assert.equal(result.kind, "refused");
		assert.match(String((result as { error: unknown }).error), /The agent did not take the message/);
	});

	test("a view the engine no longer has refuses, and nothing is delivered", async () => {
		const port = new FakeAgentViewPort({ taskId: "task-1" as TaskId });
		const { controller } = controllerOver(port);
		views.ports.clear();
		const result = await controller.submit("hello", "auto");
		assert.equal(result.kind, "refused");
		assert.deepEqual(port.calls, []);
	});
});
