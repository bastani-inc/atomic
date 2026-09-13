import assert from "node:assert/strict";
import type { ExtensionUIContext } from "@bastani/atomic";
import { afterEach, test } from "vitest";
import { createAskUserQuestionToolDefinition } from "../../packages/coding-agent/src/core/tools/ask-user-question/ask-user-question.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import type { PiCommandContext } from "../../packages/workflows/src/extension/public-types.js";
import { buildRuntimeAdapters } from "../../packages/workflows/src/extension/wiring.js";
import { handleRunControlCommand } from "../../packages/workflows/src/extension/workflow-run-control-command.js";
import { workflowQuitAction } from "../../packages/workflows/src/extension/workflow-tool-control.js";
import { quitRun } from "../../packages/workflows/src/runs/background/quit.js";
import { run } from "../../packages/workflows/src/runs/foreground/executor.js";
import { stageControlRegistry as registry } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import { type StageCustomUiRequest, StageUiBroker } from "../../packages/workflows/src/shared/stage-ui-broker.js";
import { store } from "../../packages/workflows/src/shared/store.js";
import { makeMockSession } from "./stage-runner-helpers.js";

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

afterEach(() => {
	store.clear();
	setDurableBackend(undefined);
});

test.each(["direct", "slash", "tool", "nested-tool", "answer-race"] as const)(
	"%s quit dismisses an owned ask_user_question before acknowledging stage pause",
	async (route) => {
		const broker = new StageUiBroker(store);
		const runId = crypto.randomUUID();
		const backend = new InMemoryDurableBackend();
		setDurableBackend(backend);
		const controller = new AbortController();
		const toolController = new AbortController();
		const mounted = Promise.withResolvers<void>();
		let ui: ExtensionUIContext | undefined;
		let question: Promise<unknown> | undefined;
		let request: StageCustomUiRequest | undefined;
		let hidden = 0;
		let downstream = false;
		let aborted = false;
		const { session: baseSession } = makeMockSession({
			isStreaming: true,
			async prompt() {
				assert.ok(ui);
				const execute = createAskUserQuestionToolDefinition().execute;
				question = execute(
					"owned-question",
					{
						questions: [
							{
								question: "Proceed?",
								header: "Choice",
								options: [
									{ label: "Yes", description: "Proceed" },
									{ label: "No", description: "Decline" },
								],
							},
						],
					},
					toolController.signal,
					undefined,
					{ hasUI: true, ui } as Parameters<typeof execute>[4],
				);
				await question.catch(() => {});
				return undefined;
			},
			async abort() {
				aborted = true;
				toolController.abort(new Error("session stopped"));
				await question?.catch(() => {});
			},
		});
		const session = {
			...baseSession,
			async bindExtensions(bindings: { uiContext?: ExtensionUIContext }) {
				ui = bindings.uiContext;
			},
		};
		const adapters = buildRuntimeAdapters(
			{},
			{ stageUiBroker: broker, createAgentSession: async () => ({ session }) },
		);
		const definition = workflow({
			name: "quit-hil",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await ctx.stage("question").prompt("Ask permission");
				downstream = true;
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
		const execution = run(
			route === "nested-tool" ? parent : definition,
			{},
			{
				runId,
				store,
				durableBackend: backend,
				stageControlRegistry: registry,
				adapters,
				signal: controller.signal,
				onStageStart(runId, stage) {
					broker.registerHost(runId, stage.id, {
						showCustomUi(value) {
							request = value;
							mounted.resolve();
						},
						hideCustomUi() {
							hidden++;
						},
					});
				},
			},
		);
		await mounted.promise;
		assert.ok(request);
		const unrelatedRunId = crypto.randomUUID();
		store.recordRunStart({
			id: unrelatedRunId,
			name: "unrelated",
			inputs: {},
			status: "running",
			stages: [],
			startedAt: Date.now(),
		});
		store.recordStageStart(unrelatedRunId, {
			id: request.stageId,
			name: "question",
			status: "running",
			parentIds: [],
			toolEvents: [],
		});
		let unrelatedRequest: StageCustomUiRequest | undefined;
		broker.registerHost(unrelatedRunId, request.stageId, {
			showCustomUi(value) {
				unrelatedRequest = value;
			},
		});
		const unrelated = broker.requestCustomUi(unrelatedRunId, request.stageId, () => ({ render: () => [] }));
		const stop = async (): Promise<void> => {
			if (route === "direct" || route === "answer-race") {
				assert.equal((await quitRun(runId, { store, stageControlRegistry: registry })).ok, true);
			} else if (route === "tool" || route === "nested-tool") {
				const result = await workflowQuitAction({ action: "quit", runId });
				assert.equal(result.action, "quit");
				assert.ok("status" in result);
				assert.equal(result.status, "paused");
			} else {
				const messages: string[] = [];
				await handleRunControlCommand(
					"quit",
					[runId],
					{ hasUI: false } as PiCommandContext,
					{ info: (message) => messages.push(message), error: (message) => assert.fail(message) },
					{} as never,
				);
				assert.match(messages.join("\n"), /quit/);
			}
		};
		let stopped = false;
		if (route === "answer-race")
			broker.resolve(request, {
				answers: [{ questionIndex: 0, question: "Proceed?", kind: "option", answer: "Yes" }],
				cancelled: false,
			});
		const quitting = Promise.all([stop(), stop()]).then(() => {
			stopped = true;
		});
		void quitting.catch(() => {});
		try {
			await turn();
			assert.equal(aborted, true);
			assert.equal(hidden, 1, "native tool cancellation must dismiss its brokered question");
			await quitting;
			assert.equal(stopped, true);
			assert.equal(store.runs()[0]?.status, "paused");
			assert.equal(store.runs()[0]?.exitReason, "quit");
			assert.equal(store.runs()[0]?.stages[0]?.inputRequest, undefined);
			assert.equal(downstream, false);
			assert.ok(request);
			if (route === "nested-tool") assert.notEqual(request.runId, runId);
			broker.resolve(request, { answers: [], cancelled: false });
			await turn();
			assert.equal(downstream, false, "a late answer must not release the pause gate");
			await stop();
			assert.equal(backend.getWorkflow(runId)?.status, "paused");
			assert.equal(
				store.runs().find((candidate) => candidate.id === unrelatedRunId)?.stages[0]?.status,
				"awaiting_input",
			);
			assert.equal(hidden, 1);
		} finally {
			controller.abort();
			await quitting.catch(() => {});
			await execution;
			assert.ok(unrelatedRequest);
			broker.resolve(unrelatedRequest, "ordinary answer");
			assert.equal(await unrelated, "ordinary answer");
		}
	},
);
