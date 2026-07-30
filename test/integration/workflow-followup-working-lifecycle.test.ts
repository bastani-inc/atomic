/**
 * Regression: a workflow definition that auto-sends a follow-on user message to
 * its own retained stage after the previous stream terminated must show
 * `Working` in an attached stage chat immediately, without further user input.
 *
 * The reproduced fault was a missing pre-stream UI lifecycle signal: the second
 * backend turn started while the attached chat still had `sdkBusy=false`,
 * `workingLifecycleActive=false`, and no requested render, so the pane looked
 * idle until the public `agent_start` finally arrived.
 *
 * cross-ref:
 *   - packages/workflows/src/runs/foreground/stage-runner-send-user-message.ts
 *   - packages/workflows/src/tui/stage-chat-view-delivery-activity.ts
 */

import assert from "node:assert/strict";
import { type AgentSessionEvent, initTheme } from "@bastani/atomic";
import { afterEach, beforeAll, test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { run } from "../../packages/workflows/src/runs/foreground/executor.js";
import { stageControlRegistry } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import type { StageSessionRuntime } from "../../packages/workflows/src/runs/foreground/stage-runner.js";
import { store } from "../../packages/workflows/src/shared/store.js";
import { deriveGraphTheme } from "../../packages/workflows/src/tui/graph-theme.js";
import { StageChatView } from "../../packages/workflows/src/tui/stage-chat-view.js";

const activeRuns: Promise<unknown>[] = [];

beforeAll(() => {
	initTheme("dark", false);
});

afterEach(async () => {
	stageControlRegistry.clear();
	store.clear();
	await Promise.allSettled(activeRuns.splice(0));
});

function stripAnsi(text: string): string {
	return text.replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, "").replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

function renderText(view: StageChatView): string {
	return stripAnsi(view.render(96).join("\n"));
}

/**
 * The Atomic working row: spinner glyph plus a label. `turn_start` swaps the
 * default "Working..." text for a whimsical message, so the row itself — not
 * one label — is what must stay visible without a gap.
 */
const WORKING_ROW = /∀\s+\S+/;

interface SecondTurnGates {
	readonly backendStarted: PromiseWithResolvers<void>;
	readonly publishAgentStart: PromiseWithResolvers<void>;
	readonly agentTurnVisible: PromiseWithResolvers<void>;
	readonly finishTurn: PromiseWithResolvers<void>;
}

/**
 * Mirrors the real `AgentSession` delivery contract: the backend turn is live
 * (and `promptStarted`/`delivered` have fired) before the public `agent_start`
 * clears the ordered extension event queue.
 */
function retainedStageSession(promptCalls: string[], gates: SecondTurnGates): StageSessionRuntime {
	type Listener = Parameters<StageSessionRuntime["subscribe"]>[0];
	const listeners = new Set<Listener>();
	let streaming = false;
	const emit = (event: AgentSessionEvent): void => {
		for (const listener of [...listeners]) listener(event as never);
	};
	const session = {
		async prompt(text: string) {
			promptCalls.push(text);
			streaming = true;
			emit({ type: "agent_start" } as AgentSessionEvent);
			emit({ type: "turn_start" } as AgentSessionEvent);
			emit({ type: "turn_end" } as AgentSessionEvent);
			emit({ type: "agent_end", messages: [] } as AgentSessionEvent);
			streaming = false;
		},
		async sendUserMessage(
			content: string,
			options?: {
				readonly __workflowDelivery?: {
					readonly promptStarted?: () => void;
					readonly delivered?: (action: string) => void;
				};
			},
		) {
			promptCalls.push(content);
			// The provider turn is live here; the public agent_start is still queued.
			streaming = true;
			options?.__workflowDelivery?.promptStarted?.();
			options?.__workflowDelivery?.delivered?.("prompt");
			gates.backendStarted.resolve();
			await gates.publishAgentStart.promise;
			emit({ type: "agent_start" } as AgentSessionEvent);
			emit({ type: "turn_start" } as AgentSessionEvent);
			gates.agentTurnVisible.resolve();
			await gates.finishTurn.promise;
			emit({ type: "turn_end" } as AgentSessionEvent);
			emit({ type: "agent_end", messages: [] } as AgentSessionEvent);
			streaming = false;
		},
		steer: async () => {},
		followUp: async () => {},
		subscribe(listener: Listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		sessionFile: undefined,
		sessionId: crypto.randomUUID(),
		setModel: async () => {},
		setThinkingLevel: () => {},
		cycleModel: async () => ({ model: undefined, thinkingLevel: undefined }),
		cycleThinkingLevel: () => undefined,
		agent: {} as never,
		model: undefined,
		thinkingLevel: "off",
		messages: [],
		navigateTree: async () => {},
		compact: async () => undefined,
		abortCompaction: () => {},
		abort: async () => {},
		dispose: () => {},
	} as unknown as StageSessionRuntime;
	Object.defineProperty(session, "isStreaming", { get: () => streaming });
	return session;
}

test("workflow-authored follow-up after a terminated stream shows Working immediately", async () => {
	const promptCalls: string[] = [];
	const firstTurnDone = Promise.withResolvers<void>();
	const followUpGate = Promise.withResolvers<void>();
	const gates: SecondTurnGates = {
		backendStarted: Promise.withResolvers<void>(),
		publishAgentStart: Promise.withResolvers<void>(),
		agentTurnVisible: Promise.withResolvers<void>(),
		finishTurn: Promise.withResolvers<void>(),
	};
	const ids = Promise.withResolvers<{ runId: string; stageId: string }>();

	const def = workflow({
		name: "workflow-followup-working-lifecycle",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			const stage = ctx.stage("retained");
			await stage.prompt("first turn");
			firstTurnDone.resolve();
			await followUpGate.promise;
			await stage.sendUserMessage("automatic second turn");
			return {};
		},
	});

	const runPromise = run(
		def,
		{},
		{
			store,
			stageControlRegistry,
			adapters: {
				agentSession: {
					async create() {
						return retainedStageSession(promptCalls, gates);
					},
				},
			},
			onStageStart(runId, stage) {
				ids.resolve({ runId, stageId: stage.id });
			},
			confirmStageReadiness: async () => true,
		},
	);
	activeRuns.push(runPromise);

	const target = await ids.promise;
	await firstTurnDone.promise;

	const handle = stageControlRegistry.get(target.runId, target.stageId);
	assert.ok(handle, "expected a retained stage-control handle after the first turn");

	let renderRequests = 0;
	const view = new StageChatView({
		store,
		graphTheme: deriveGraphTheme({}),
		runId: target.runId,
		stageId: target.stageId,
		workflowName: "workflow-followup-working-lifecycle",
		handle,
		onDetach: () => {},
		onClose: () => {},
		requestRender: () => {
			renderRequests += 1;
		},
	});

	try {
		assert.deepEqual(promptCalls, ["first turn"]);
		assert.doesNotMatch(renderText(view), /Working/);
		assert.equal(view._hasAnimationTick, false);

		// No further user input: the workflow definition itself sends the message.
		followUpGate.resolve();
		await gates.backendStarted.promise;

		assert.deepEqual(promptCalls, ["first turn", "automatic second turn"]);
		assert.match(renderText(view), /Working/, "expected Working while the workflow-authored second turn is starting");
		assert.equal(view._hasAnimationTick, true);
		assert.ok(renderRequests > 0, "expected an immediate render request");

		// Handing over to the real agent turn must not blink the status off.
		gates.publishAgentStart.resolve();
		await gates.agentTurnVisible.promise;
		assert.match(renderText(view), WORKING_ROW);
		assert.equal(view._hasAnimationTick, true);

		gates.finishTurn.resolve();
		const completed = await runPromise;
		assert.equal(completed.status, "completed");
		assert.doesNotMatch(renderText(view), WORKING_ROW);
		assert.doesNotMatch(renderText(view), /Working/);
		assert.equal(view._hasAnimationTick, false);
	} finally {
		gates.publishAgentStart.resolve();
		gates.finishTurn.resolve();
		view.dispose();
	}
});

test("a chat attached mid-delivery shows Working without waiting for agent_start", async () => {
	const promptCalls: string[] = [];
	const firstTurnDone = Promise.withResolvers<void>();
	const followUpGate = Promise.withResolvers<void>();
	const gates: SecondTurnGates = {
		backendStarted: Promise.withResolvers<void>(),
		publishAgentStart: Promise.withResolvers<void>(),
		agentTurnVisible: Promise.withResolvers<void>(),
		finishTurn: Promise.withResolvers<void>(),
	};
	const ids = Promise.withResolvers<{ runId: string; stageId: string }>();

	const def = workflow({
		name: "workflow-followup-late-attach",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			const stage = ctx.stage("retained");
			await stage.prompt("first turn");
			firstTurnDone.resolve();
			await followUpGate.promise;
			await stage.sendUserMessage("automatic second turn");
			return {};
		},
	});

	const runPromise = run(
		def,
		{},
		{
			store,
			stageControlRegistry,
			adapters: {
				agentSession: {
					async create() {
						return retainedStageSession(promptCalls, gates);
					},
				},
			},
			onStageStart(runId, stage) {
				ids.resolve({ runId, stageId: stage.id });
			},
			confirmStageReadiness: async () => true,
		},
	);
	activeRuns.push(runPromise);

	const target = await ids.promise;
	await firstTurnDone.promise;

	// Nothing is attached yet: the delivery is admitted and the backend turn
	// starts while the pane does not exist.
	followUpGate.resolve();
	await gates.backendStarted.promise;
	assert.deepEqual(promptCalls, ["first turn", "automatic second turn"]);

	const handle = stageControlRegistry.get(target.runId, target.stageId);
	assert.ok(handle, "expected a retained stage-control handle mid-delivery");

	let renderRequests = 0;
	const view = new StageChatView({
		store,
		graphTheme: deriveGraphTheme({}),
		runId: target.runId,
		stageId: target.stageId,
		workflowName: "workflow-followup-late-attach",
		handle,
		onDetach: () => {},
		onClose: () => {},
		requestRender: () => {
			renderRequests += 1;
		},
	});

	try {
		assert.match(
			renderText(view),
			/Working/,
			"expected Working on attach while the workflow-authored turn was already running",
		);
		assert.equal(view._hasAnimationTick, true);
		assert.ok(renderRequests > 0, "expected an immediate render request on attach");

		gates.publishAgentStart.resolve();
		await gates.agentTurnVisible.promise;
		assert.match(renderText(view), WORKING_ROW);
		assert.equal(view._hasAnimationTick, true);

		gates.finishTurn.resolve();
		const completed = await runPromise;
		assert.equal(completed.status, "completed");
		assert.doesNotMatch(renderText(view), WORKING_ROW);
		assert.equal(view._hasAnimationTick, false);
		assert.deepEqual(promptCalls, ["first turn", "automatic second turn"]);
	} finally {
		gates.publishAgentStart.resolve();
		gates.finishTurn.resolve();
		view.dispose();
	}
});
