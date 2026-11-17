import assert from "node:assert/strict";
import { test } from "vitest";
import { AgentSession } from "../../packages/coding-agent/src/core/agent-session.ts";
import { AgentSessionRuntime } from "../../packages/coding-agent/src/core/agent-session-runtime.ts";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.ts";
import { AgentPanelSourceHub } from "../../packages/coding-agent/src/core/tasks/agent-panel-source.ts";
import {
	createStopAllChord,
	createStopAllNotices,
	STOP_ALL_STATUS_KEY,
} from "../../packages/coding-agent/src/modes/interactive/interactive-stop-all.ts";
import { createRpcCommandHandler } from "../../packages/coding-agent/src/modes/rpc/rpc-command-handler.ts";
import { createRpcInputLineHandler } from "../../packages/coding-agent/src/modes/rpc/rpc-input.ts";
import {
	createRpcInputScheduler,
	isConcurrentRpcControlLine,
} from "../../packages/coding-agent/src/modes/rpc/rpc-input-scheduler.ts";
import type { RpcResponse } from "../../packages/coding-agent/src/modes/rpc/rpc-types.ts";
import { sleep } from "../helpers/runtime.js";

const CTRL_X = "\x18";
const CTRL_K = "\x0b";

test("clears an expired stop-all notice and opens the agent panel while stop_all_background remains pending (#5239)", async () => {
	const statuses: Array<string | undefined> = [];
	let releaseQuit!: () => void;
	const quitGate = new Promise<void>((resolve) => {
		releaseQuit = resolve;
	});
	const hub = new AgentPanelSourceHub();
	hub.register({
		items: () => [{ id: "workflow:r1", kind: "workflow", name: "deploy", task: "stage build", state: "running" }],
		subscribe: () => () => {},
	});
	const session = Object.create(AgentSession.prototype, {
		extensionRunner: {
			value: {
				getUIContext: () => ({
					setStatus: (key: string, text: string | undefined) => {
						if (key === STOP_ALL_STATUS_KEY) statuses.push(text);
					},
					notify: () => {},
				}),
				getAgentPanelSourceHub: () => hub,
			},
		},
		workflows: {
			value: {
				listRuns: async () => [{ runId: "r1", status: "running", endedAt: undefined }],
				quit: async () => {
					await quitGate;
					return { status: "quit", failedRuns: [] };
				},
			},
		},
	}) as AgentSession;
	const runtimeHost = Object.create(AgentSessionRuntime.prototype, {
		services: { value: { agentDir: "/fixture" } },
	}) as AgentSessionRuntime;
	const responses: RpcResponse[] = [];
	let panelOpens = 0;
	const handleCommand = createRpcCommandHandler({
		runtimeHost,
		getSession: () => session,
		rebindSession: async () => {},
		output: (response) => responses.push(response as RpcResponse),
		keybindings: new KeybindingsManager(),
		taskInspectorUi: {
			custom: async <T>(): Promise<T> => {
				panelOpens++;
				return undefined as T;
			},
		},
	});
	const lineHandler = createRpcInputLineHandler({
		output: (response) => responses.push(response as RpcResponse),
		pendingExtensionRequests: new Map() as never,
		handleCommand,
		checkShutdownRequested: () => {},
	});
	const send = createRpcInputScheduler(lineHandler);
	let nextId = 0;
	const pending = new Map<string, (response: RpcResponse) => void>();
	const rpc = (command: object): Promise<RpcResponse> => {
		const id = `c${++nextId}`;
		return new Promise<RpcResponse>((resolve) => {
			pending.set(id, resolve);
			send(JSON.stringify({ id, ...command }));
		});
	};
	const settleResponses = () => {
		for (const response of responses) {
			if (response.id !== undefined) {
				const resolve = pending.get(response.id);
				if (resolve) {
					pending.delete(response.id);
					resolve(response);
				}
			}
		}
	};

	const timers: Array<() => void> = [];
	const notices = createStopAllNotices(
		{
			setEngineNotice: (text) => {
				void rpc({ type: "set_stop_all_notice", ...(text === undefined ? {} : { text }) });
			},
			hasOverlay: () => true,
			requestRender: () => {},
		},
		{
			setTimeout: ((callback: () => void) => {
				timers.push(callback);
				return { unref() {} } as ReturnType<typeof setTimeout>;
			}) as typeof setTimeout,
			clearTimeout: (() => {}) as typeof clearTimeout,
		},
	);

	let now = 0;
	const chord = createStopAllChord(
		{
			keybindings: new KeybindingsManager(),
			chordAllowed: () => true,
			stopAll: async () => {
				const response = await rpc({ type: "stop_all_background" });
				if (response.command === "stop_all_background" && response.success) return response.data;
				throw new Error("stop_all_background failed");
			},
			showStatus: (message) => notices.show(message),
			showWarning: (message) => notices.show(message),
			clearStatus: () => notices.clear(),
		},
		() => now,
	);

	try {
		const prompt = "Press ctrl+x ctrl+k again within 3s to stop all background subagents, shells and workflow runs";
		chord(CTRL_X);
		chord(CTRL_K);
		await sleep(20);
		settleResponses();
		assert.equal(statuses.at(-1), prompt);

		now += 500;
		chord(CTRL_X);
		chord(CTRL_K);
		await sleep(20);
		settleResponses();
		assert.equal(
			responses.some((response) => response.command === "stop_all_background"),
			false,
			"stop_all_background is still running",
		);

		// The 3s confirm window expires while stop_all_background is still pending.
		timers.shift()?.();
		await sleep(20);
		settleResponses();
		assert.equal(
			statuses.at(-1),
			undefined,
			"the expired 'press again within 3s' notice clears while stop_all_background is still running",
		);

		// Opening the agent panel succeeds while stop_all_background remains pending.
		void rpc({ type: "open_agent_panel" });
		await sleep(20);
		settleResponses();
		assert.equal(
			responses.some((response) => response.command === "open_agent_panel" && response.success),
			true,
			"open_agent_panel is answered while stop_all_background remains pending",
		);
		assert.equal(panelOpens, 1, "the agent panel opens while stop_all_background remains pending");
		assert.equal(
			responses.some((response) => response.command === "stop_all_background"),
			false,
			"stop_all_background remains pending after the panel opens",
		);
		assert.equal(isConcurrentRpcControlLine(JSON.stringify({ type: "stop_all_background" })), true);

		releaseQuit();
		await sleep(20);
		settleResponses();
		await sleep(20);
		settleResponses();
		assert.equal(
			responses.some((response) => response.command === "stop_all_background" && response.success),
			true,
		);
		assert.equal(statuses.at(-1), "Stopped 1 workflow run.");

		timers.shift()?.();
		await sleep(20);
		settleResponses();
		assert.equal(statuses.at(-1), undefined);
	} finally {
		releaseQuit();
	}
});
