import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import type { PiCommandContext } from "../../packages/workflows/src/extension/public-types.js";
import { buildRuntimeAdapters } from "../../packages/workflows/src/extension/wiring.js";
import { handleRunControlCommand } from "../../packages/workflows/src/extension/workflow-run-control-command.js";
import { workflowQuitAction } from "../../packages/workflows/src/extension/workflow-tool-control.js";
import {
	askReadinessViaStageBroker,
	READINESS_GATE_ADVANCE_LABEL,
	type RunOpts,
	run,
} from "../../packages/workflows/src/runs/foreground/executor.js";
import { stageControlRegistry } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import {
	stageUiBroker as broker,
	type StageCustomUiRequest,
} from "../../packages/workflows/src/shared/stage-ui-broker.js";
import { store } from "../../packages/workflows/src/shared/store.js";
import { makeMockSession } from "./stage-runner-helpers.js";

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
const ready = {
	answers: [{ questionIndex: 0, kind: "option", answer: READINESS_GATE_ADVANCE_LABEL }],
	cancelled: false,
};

afterEach(() => {
	store.clear();
	setDurableBackend(undefined);
});

function startReadiness(
	options: {
		nested?: boolean;
		usePromptNodesForUi?: boolean;
		confirmStageReadiness?: RunOpts["confirmStageReadiness"];
		afterStage?: () => Promise<void>;
		abort?: () => Promise<void>;
	} = {},
) {
	const root = new AbortController();
	const backend = new InMemoryDurableBackend();
	setDurableBackend(backend);
	const runId = crypto.randomUUID();
	const first = Promise.withResolvers<StageCustomUiRequest>();
	const second = Promise.withResolvers<StageCustomUiRequest>();
	const state = { hidden: 0, downstream: 0, mounted: 0 };
	const { session, emit } = makeMockSession({
		isStreaming: false,
		...(options.abort ? { abort: options.abort } : {}),
		async prompt() {
			emit({ type: "tool_execution_start", toolCallId: "answered", toolName: "ask_user_question", args: {} });
			emit({
				type: "tool_execution_end",
				toolCallId: "answered",
				toolName: "ask_user_question",
				result: { content: [], details: {} },
				isError: false,
			});
		},
	});
	const definition = workflow({
		name: "readiness-quit",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.stage("ready").prompt("Work");
			if (options.afterStage) await options.afterStage();
			state.downstream++;
			return {};
		},
	});
	const parent = workflow({
		name: "parent",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.workflow(definition);
			return {};
		},
	});
	const pending = run(
		options.nested ? parent : definition,
		{},
		{
			runId,
			store,
			signal: root.signal,
			durableBackend: backend,
			stageControlRegistry,
			usePromptNodesForUi: options.usePromptNodesForUi ?? true,
			confirmStageReadiness: options.confirmStageReadiness,
			adapters: buildRuntimeAdapters({}, { stageUiBroker: broker, createAgentSession: async () => ({ session }) }),
			onStageStart(owner, stage) {
				broker.registerHost(owner, stage.id, {
					showCustomUi(request) {
						state.mounted++;
						(state.mounted === 1 ? first : second).resolve(request);
					},
					hideCustomUi() {
						state.hidden++;
					},
				});
			},
		},
	);
	return {
		root,
		backend,
		runId,
		first: first.promise,
		second: second.promise,
		state,
		pending,
		async close() {
			root.abort();
			await pending;
		},
	};
}

// Related: #2897. A failed quit must roll back admission, not strand an accepted answer.
test("failed quit acknowledgement releases accepted readiness without requiring resume", async () => {
	const fixture = startReadiness({
		async abort() {
			throw new Error("abort failed");
		},
	});
	try {
		const request = await fixture.first;
		const handle = stageControlRegistry.get(fixture.runId, request.stageId)!;
		broker.resolve(request, ready);
		const result = await workflowQuitAction({ action: "quit", runId: fixture.runId });
		assert.ok("status" in result);
		assert.equal(result.status, "noop");
		assert.ok(result.message);
		assert.match(result.message, /Failed to pause workflow stages: .*abort failed/);
		for (let index = 0; index < 20; index++) await turn();
		assert.equal(fixture.state.downstream, 1, "failed pause must not strand accepted readiness");
		assert.equal(handle.status, "completed");
		assert.equal(store.runs().find((item) => item.id === fixture.runId)?.status, "completed");
		assert.equal(fixture.root.signal.aborted, false);
	} finally {
		await fixture.close();
	}
});

test("concurrent failed pauses keep readiness fenced until acknowledgement and recover after resume", async () => {
	const abort = Promise.withResolvers<void>();
	const failure = new Error("abort failed");
	const fixture = startReadiness({ abort: () => abort.promise });
	try {
		const request = await fixture.first;
		const handle = stageControlRegistry.get(fixture.runId, request.stageId)!;
		broker.resolve(request, ready);
		const pauses = Promise.allSettled([handle.pause(), handle.pause()]);
		for (let index = 0; index < 20; index++) await turn();
		assert.equal(handle.status, "running");
		assert.equal(fixture.state.downstream, 0, "unacknowledged pause must fence readiness");
		abort.reject(failure);
		assert.deepEqual(await pauses, [
			{ status: "rejected", reason: failure },
			{ status: "rejected", reason: failure },
		]);
		await handle.resume();
		for (let index = 0; index < 20; index++) await turn();
		assert.equal(fixture.state.downstream, 1);
		assert.equal(handle.status, "completed");
		assert.equal(fixture.root.signal.aborted, false);
	} finally {
		abort.reject(failure);
		await fixture.close();
	}
});

test("successful retry after failed pause retains readiness admission until explicit resume", async () => {
	let aborts = 0;
	const failure = new Error("first abort failed");
	const fixture = startReadiness({
		async abort() {
			if (++aborts === 1) throw failure;
		},
	});
	try {
		const request = await fixture.first;
		const handle = stageControlRegistry.get(fixture.runId, request.stageId)!;
		broker.resolve(request, ready);
		await handle.pause().catch(async (error) => {
			assert.equal(error, failure);
			await handle.pause();
		});
		assert.equal(aborts, 2);
		for (let index = 0; index < 20; index++) await turn();
		assert.equal(handle.status, "paused");
		assert.equal(fixture.state.downstream, 0);
		assert.equal(store.runs().find((item) => item.id === fixture.runId)?.status, "paused");
		await handle.resume();
		for (let index = 0; index < 20; index++) await turn();
		assert.equal(fixture.state.downstream, 1);
		assert.equal(handle.status, "completed");
	} finally {
		await fixture.close();
	}
});

// Related: #2897. The idle executor-owned readiness question also needs cancellation.
test.each(["tool", "slash", "slash-implicit", "nested-tool", "answer-race"] as const)(
	"%s quit dismisses readiness and rejects late answers without advancing",
	async (route) => {
		const fixture = startReadiness({ nested: route === "nested-tool" });
		const { root, backend, runId, state } = fixture;
		try {
			const request = await fixture.first;
			assert.equal(broker.peekStagePrompt(request.runId, request.stageId)?.kind, "readiness_gate");
			if (route === "nested-tool") assert.notEqual(request.runId, runId);
			const stop = async () => {
				if (route === "slash" || route === "slash-implicit") {
					const messages: string[] = [];
					await handleRunControlCommand(
						"quit",
						route === "slash" ? [runId] : [],
						{ hasUI: false } as PiCommandContext,
						{ info: (message) => messages.push(message), error: (message) => assert.fail(message) },
						{} as never,
					);
					assert.match(messages.join("\n"), /quit/);
				} else {
					const result = await workflowQuitAction({ action: "quit", runId });
					assert.ok("status" in result);
					assert.equal(result.status, "paused");
				}
			};
			if (route === "answer-race") broker.resolve(request, ready);
			await Promise.all([stop(), stop()]);
			const hiddenAtQuit = state.hidden;
			const answerableAtQuit = !!broker.peekStagePrompt(request.runId, request.stageId);
			broker.resolve(request, ready);
			await turn();
			assert.deepEqual(
				{ hiddenAtQuit, answerableAtQuit, downstream: state.downstream, status: store.runs()[0]?.status },
				{ hiddenAtQuit: 1, answerableAtQuit: false, downstream: 0, status: "paused" },
			);
			assert.equal(root.signal.aborted, false);
			assert.equal(store.runs()[0]?.exitReason, "quit");
			assert.equal(backend.getWorkflow(runId)?.status, "paused");
			await stop();
			assert.equal(state.hidden, 1);
		} finally {
			await fixture.close();
		}
	},
);

test.each(["pause", "quit"] as const)("%s readiness requires a fresh answer after explicit resume", async (action) => {
	const fixture = startReadiness();
	try {
		const old = await fixture.first;
		const handle = stageControlRegistry.get(old.runId, old.stageId);
		assert.ok(handle);
		if (action === "pause") await handle.pause();
		else await workflowQuitAction({ action: "quit", runId: fixture.runId });
		assert.equal(fixture.state.hidden, 1);
		broker.resolve(old, ready);
		await turn();
		assert.equal(fixture.state.downstream, 0);
		assert.equal(fixture.state.mounted, 1);
		await handle.resume();
		const fresh = await fixture.second;
		assert.notEqual(fresh.id, old.id);
		broker.resolve(old, ready);
		await turn();
		assert.equal(fixture.state.downstream, 0);
		assert.ok(broker.peekStagePrompt(fresh.runId, fresh.stageId));
		broker.resolve(fresh, ready);
		await fixture.pending;
		assert.equal(fixture.state.downstream, 1);
		assert.equal(store.runs()[0]?.status, "completed");
	} finally {
		await fixture.close();
	}
});

test("ordinary readiness answer completes without pause", async () => {
	const fixture = startReadiness();
	try {
		broker.resolve(await fixture.first, ready);
		await fixture.pending;
		assert.equal(fixture.state.downstream, 1);
		assert.equal(fixture.state.hidden, 1);
		assert.equal(store.runs()[0]?.status, "completed");
	} finally {
		await fixture.close();
	}
});

test("readiness disabled does not create a question", async () => {
	const fixture = startReadiness({ usePromptNodesForUi: false });
	try {
		await fixture.pending;
		assert.equal(fixture.state.downstream, 1);
		assert.equal(fixture.state.mounted, 0);
	} finally {
		await fixture.close();
	}
});

test.each(["quit-first", "answer-first"] as const)(
	"%s cancels an override readiness attempt even when the callback ignores abort",
	async (order) => {
		const first = Promise.withResolvers<{ signal: AbortSignal; runId: string; stageId: string }>();
		const stale = Promise.withResolvers<boolean>();
		const second = Promise.withResolvers<void>();
		const fresh = Promise.withResolvers<boolean>();
		let attempts = 0;
		const fixture = startReadiness({
			usePromptNodesForUi: false,
			confirmStageReadiness: async (request) => {
				if (++attempts === 1) {
					first.resolve(request);
					return await stale.promise;
				}
				second.resolve();
				return await fresh.promise;
			},
		});
		try {
			const request = await first.promise;
			if (order === "answer-first") stale.resolve(true);
			await workflowQuitAction({ action: "quit", runId: fixture.runId });
			assert.equal(request.signal.aborted, true);
			stale.resolve(true);
			await turn();
			assert.equal(fixture.state.downstream, 0);
			assert.equal(attempts, 1);
			const handle = stageControlRegistry.get(request.runId, request.stageId);
			assert.ok(handle);
			await handle.resume();
			await second.promise;
			assert.equal(fixture.state.downstream, 0);
			fresh.resolve(true);
			await fixture.pending;
			assert.equal(fixture.state.downstream, 1);
		} finally {
			stale.resolve(true);
			fresh.resolve(true);
			await fixture.close();
		}
	},
);

test("already-aborted readiness signal rejects without mounting or approving", async () => {
	const root = new AbortController();
	const reason = new Error("already stopped");
	root.abort(reason);
	await assert.rejects(
		askReadinessViaStageBroker(crypto.randomUUID(), "ready", root.signal),
		(error) => error === reason,
	);
});

test("root abort dismisses a pending readiness question without approval", async () => {
	const fixture = startReadiness();
	try {
		const request = await fixture.first;
		fixture.root.abort(new Error("root stopped"));
		await fixture.pending;
		broker.resolve(request, ready);
		assert.equal(fixture.state.downstream, 0);
		assert.equal(fixture.state.hidden, 1);
		assert.equal(broker.peekStagePrompt(request.runId, request.stageId), undefined);
		assert.notEqual(store.runs()[0]?.status, "completed");
	} finally {
		await fixture.close();
	}
});

test("quitting readiness preserves an unrelated question with the same local stage id", async () => {
	const fixture = startReadiness();
	const other = crypto.randomUUID();
	let otherRequest: StageCustomUiRequest | undefined;
	let otherQuestion: Promise<object> | undefined;
	const answer = Object.freeze({ values: ["", " ", "duplicate", "duplicate", 0] });
	try {
		const request = await fixture.first;
		store.recordRunStart({
			id: other,
			name: "other",
			inputs: {},
			status: "running",
			stages: [],
			startedAt: Date.now(),
		});
		store.recordStageStart(other, {
			id: request.stageId,
			name: "ready",
			status: "running",
			parentIds: [],
			toolEvents: [],
		});
		broker.registerHost(other, request.stageId, {
			showCustomUi(value) {
				otherRequest = value;
			},
		});
		otherQuestion = broker.requestCustomUi<object>(other, request.stageId, () => ({ render: () => [] }));
		await workflowQuitAction({ action: "quit", runId: fixture.runId });
		assert.equal(store.runs().find((candidate) => candidate.id === other)?.stages[0]?.status, "awaiting_input");
		assert.ok(otherRequest);
		broker.resolve(otherRequest, answer);
		assert.equal(await otherQuestion, answer);
		assert.equal(fixture.state.downstream, 0);
	} finally {
		if (otherRequest) broker.resolve(otherRequest, answer);
		await otherQuestion;
		await fixture.close();
	}
});

test("answer-versus-quit fences every nonterminal stage during asynchronous finalization", async () => {
	let activeOrders = 0;
	// Related: #2897. Exercise consumed answers while checkpointing, not only pending UI.
	for (let delay = 0; delay < 60; delay++) {
		const fixture = startReadiness();
		try {
			const request = await fixture.first;
			const handle = stageControlRegistry.get(request.runId, request.stageId);
			assert.ok(handle);
			broker.resolve(request, ready);
			for (let tick = 0; tick < delay; tick++) await Promise.resolve();
			let stageAtPause: typeof handle.status | undefined;
			const pause = handle.pause.bind(handle);
			handle.pause = () => {
				stageAtPause = handle.status;
				return pause();
			};
			const beforeQuit = fixture.state.downstream;
			const result = await workflowQuitAction({ action: "quit", runId: fixture.runId });
			await turn();
			if (stageAtPause !== undefined && stageAtPause !== "completed") {
				activeOrders++;
				assert.equal(beforeQuit, 0);
				assert.ok("status" in result);
				assert.equal(result.status, "paused");
				assert.equal(fixture.state.downstream, 0, `quit admitted late continuation at delay ${delay}`);
				assert.equal(store.runs()[0]?.status, "paused", `quit revived at delay ${delay}`);
				assert.equal(fixture.backend.getWorkflow(fixture.runId)?.status, "paused");
			}
		} finally {
			await fixture.close();
			store.clear();
		}
	}
	assert.ok(activeOrders > 7, "sweep must cover asynchronous finalization as well as pending readiness");
});

test("a readiness stage completed before quit selection retains the admitted answer winner", async () => {
	const admitted = Promise.withResolvers<void>();
	const continueUntracked = Promise.withResolvers<void>();
	const fixture = startReadiness({
		afterStage: async () => {
			admitted.resolve();
			await continueUntracked.promise;
		},
	});
	try {
		const request = await fixture.first;
		broker.resolve(request, ready);
		await admitted.promise;
		assert.equal(store.runs()[0]?.stages[0]?.status, "completed");
		assert.equal(fixture.state.downstream, 0);
		assert.equal(broker.peekStagePrompt(request.runId, request.stageId), undefined);
		// Existing limitation: quit cannot retract already-started, untracked JS.
		// This is not a pending readiness answer reviving a nonterminal stage.
		const result = await workflowQuitAction({ action: "quit", runId: fixture.runId });
		assert.ok("status" in result);
		assert.equal(result.status, "paused");
		continueUntracked.resolve();
		await fixture.pending;
		await turn();
		assert.equal(fixture.state.downstream, 1);
		assert.equal(store.runs()[0]?.status, "paused");
	} finally {
		continueUntracked.resolve();
		await fixture.close();
	}
});
