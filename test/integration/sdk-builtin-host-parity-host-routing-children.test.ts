import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCurrentTools } from "@bastani/atomic-ai";
import { test, vi } from "vitest";
import {
	createAgentSession,
	type HostInputOptions,
	SessionManager,
	SettingsManager,
} from "../../packages/coding-agent/src/index.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { createMemoryTestBackend } from "../helpers/workflow-journal.js";
import { runBuiltNodeFixture } from "./sdk-builtin-host-parity-helpers.js";

// #3105: ordinary non-prompt-node refusal is separate from a required durable gate.
test("missing adapter refuses ordinary dialog and leaves durable approval pending", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "atomic-missing-host-"));
	const { session } = await createAgentSession({
		cwd,
		agentDir: join(cwd, "agent"),
		sessionManager: SessionManager.inMemory(cwd),
		settingsManager: SettingsManager.inMemory(),
		builtins: { subagents: false, intercom: false, mcp: false, "web-access": false },
	});
	const context = session.extensionRunner!.createContext();
	const store = createStore();
	const controller = new AbortController();
	let effects = 0;
	try {
		const ordinary = workflow({
			name: "ordinary-missing",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await ctx.ui.input("ordinary");
				return {};
			},
		});
		const result = await run(
			ordinary,
			{},
			{
				store,
				durableBackend: await createMemoryTestBackend(),
				usePromptNodesForUi: false,
				ui: {
					custom: async () => {
						throw new Error("Unexpected custom UI invocation");
					},
					input: async (prompt) => (await context.ui.input(prompt))!,
					confirm: (message) => context.ui.confirm("approval", message),
					select: async (message, choices) => (await context.ui.select(message, [...choices])) as never,
					editor: async (initial) => (await context.ui.editor("editor", initial))!,
				},
			},
		);
		assert.equal(result.status, "failed");
		assert.match(result.error ?? "", /HumanInputUnavailable/);
		const durable = workflow({
			name: "durable-missing",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				if (await ctx.ui.confirm("required approval")) await ctx.tool("guarded", {}, async () => ++effects);
				return {};
			},
		});
		const pending = run(
			durable,
			{},
			{
				store,
				durableBackend: await createMemoryTestBackend(),
				usePromptNodesForUi: true,
				signal: controller.signal,
			},
		);
		try {
			await vi.waitFor(() =>
				assert.ok(store.runs().some((run) => run.stages.some((stage) => stage.pendingPrompt?.kind === "confirm"))),
			);
			assert.equal(effects, 0);
		} finally {
			controller.abort();
			await pending;
		}
		assert.equal(effects, 0);
	} finally {
		await session.dispose();
		rmSync(cwd, { recursive: true, force: true });
	}
});

// #3105: human capability is not permission to bypass an exhausted budget.
test.each(["missing", "nonapproval"] as const)("workflow budget stays blocked with %s input", async (host) => {
	const cwd = mkdtempSync(join(tmpdir(), "atomic-host-budget-"));
	const directory = join(cwd, ".atomic", "workflows");
	mkdirSync(directory, { recursive: true });
	const effect = join(cwd, "effect");
	writeFileSync(
		join(directory, "host-budget.ts"),
		`
import { workflow } from "@bastani/atomic/workflows";
import { writeFileSync } from "node:fs";
import { setTimeout } from "node:timers/promises";
export default workflow({ name: "host-budget", description: "budget boundary", inputs: {}, outputs: {},
  budget: { maxDurationMs: 1 }, run: async (ctx) => {
    await ctx.tool("exhaust-budget", {}, async () => { await setTimeout(10); return true; });
    await ctx.tool("must-not-run", {}, async () => { writeFileSync(${JSON.stringify(effect)}, "unauthorized"); return true; });
    return {};
  }
});`,
	);
	const { session } = await createAgentSession({
		cwd,
		agentDir: join(cwd, "agent"),
		sessionManager: SessionManager.inMemory(cwd),
		settingsManager: SettingsManager.inMemory(),
		builtins: { subagents: false, mcp: false, intercom: false, "web-access": false },
		extensionBindings: {
			humanInput:
				host === "missing"
					? null
					: {
							input: async () => undefined,
							confirm: async () => false,
							select: async () => undefined,
							editor: async () => undefined,
							questionnaire: async () => ({ answers: [], cancelled: true }),
						},
		},
	});
	try {
		const tool = session.agent.state.tools.find((entry) => entry.name === "workflow")!;
		await tool.execute("run", { action: "run", workflow: "host-budget", inputs: {} }, new AbortController().signal);
		await vi.waitFor(
			async () => {
				const details = (await tool.execute("status", { action: "status" }, new AbortController().signal)).details;
				assert.match(JSON.stringify(details), /"status":"budget_exceeded"/);
			},
			{ timeout: 5000 },
		);
		assert.equal(existsSync(effect), false);
		await session.bindExtensions({});
		await new Promise((resolve) => setImmediate(resolve));
		const details = (await tool.execute("status", { action: "status" }, new AbortController().signal)).details;
		assert.match(JSON.stringify(details), /"status":"budget_exceeded"/);
		assert.equal(existsSync(effect), false, "rebinding cannot raise the exhausted budget");
	} finally {
		await session.dispose();
		rmSync(cwd, { recursive: true, force: true });
	}
});

// Real Node imports built assets and exits normally after awaited public session disposal.
const BUILT_NODE_HOST_PROCESS_TIMEOUT_MS = 60_000;
// #3105: source-alias tests are not executable package host-routing evidence.
test(
	"built non-TTY Node routes the unchanged workflow and exits after public session disposal",
	() => {
		const result = runBuiltNodeFixture("sdk-host-built-node.mjs", [], [], {
			...process.env,
		});
		assert.equal(result.exitCode, 0, result.stderr.toString());
		const receipt = JSON.parse(result.stdout.toString().trim());
		assert.equal(receipt.host, "built-node");
		assert.equal(
			receipt.hash,
			createHash("sha256")
				.update(readFileSync(new URL("../fixtures/sdk-host-durable-workflow.ts", import.meta.url)))
				.digest("hex"),
		);
		assert.deepEqual(receipt.result, { text: "  durable text  ", approved: true });
		assert.equal(receipt.effects, 1);
	},
	BUILT_NODE_HOST_PROCESS_TIMEOUT_MS,
);

test(
	"built non-TTY Node finalizes a pending workflow when replacement creation rejects before a new session",
	() => {
		const result = runBuiltNodeFixture("sdk-host-built-node.mjs", ["--replacement-failure"], [], {
			...process.env,
		});
		assert.equal(result.exitCode, 0, result.stderr.toString());
		assert.deepEqual(JSON.parse(result.stdout.toString().trim()), {
			host: "built-node",
			replacementFailed: true,
			initiallyPending: true,
			disposed: true,
		});
	},
	BUILT_NODE_HOST_PROCESS_TIMEOUT_MS,
);

// #3105: duplicate answers are rejected by the runtime's pending identity, not only Promise settlement.
test("durable prompt identity accepts one answer and refuses a repeated answer", async () => {
	const store = createStore();
	let effects = 0;
	const definition = workflow({
		name: "duplicate-gate",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			if (await ctx.ui.confirm("approve once")) await ctx.tool("guarded", {}, async () => ++effects);
			return {};
		},
	});
	const controller = new AbortController();
	const pending = run(
		definition,
		{},
		{ store, durableBackend: await createMemoryTestBackend(), usePromptNodesForUi: true, signal: controller.signal },
	);
	try {
		await vi.waitFor(() => assert.ok(store.runs()[0]?.stages.some((stage) => stage.pendingPrompt)));
		const root = store.runs()[0]!;
		const stage = root.stages.find((stage) => stage.pendingPrompt)!;
		const promptId = stage.pendingPrompt!.id;
		assert.equal(store.resolveStagePendingPrompt(root.id, stage.id, promptId, true), true);
		assert.equal(store.resolveStagePendingPrompt(root.id, stage.id, promptId, true), false);
		assert.equal((await pending).status, "completed");
		assert.equal(store.resolveStagePendingPrompt(root.id, stage.id, promptId, true), false);
		assert.equal(effects, 1);
	} finally {
		controller.abort();
		await pending;
	}
});

// #3105: production workflow adapter must narrow, not replace, its parent's selection.
test("workflow child inherits SDK host and disabled tool ceiling", async () => {
	const { buildRuntimeAdapters } = await import("../../packages/workflows/src/extension/wiring.js");
	const cwd = mkdtempSync(join(tmpdir(), "atomic-child-inheritance-"));
	const { session: parent } = await createAgentSession({
		cwd,
		agentDir: join(cwd, "agent"),
		sessionManager: SessionManager.inMemory(cwd),
		settingsManager: SettingsManager.inMemory(),
		builtins: { subagents: false, intercom: false, mcp: false, "web-access": false },
		excludedTools: ["bash"],
		extensionBindings: {
			humanInput: {
				input: async () => "  inherited  ",
				confirm: async () => false,
				select: async () => undefined,
				editor: async () => undefined,
				questionnaire: async () => ({ answers: [], cancelled: true }),
			},
		},
	});
	let child: typeof parent | undefined;
	try {
		const adapters = buildRuntimeAdapters(
			{ getChildSessionOptions: parent.extensionRunner.createContext().getChildSessionOptions },
			{
				createAgentSession: async (options) => {
					const result = await createAgentSession(options);
					child = result.session;
					return result as unknown as import("../../packages/workflows/src/runs/foreground/stage-runner.js").StageSessionCreateResult;
				},
			},
		);
		await adapters.agentSession!.create({
			tools: ["bash", "read", "workflow"],
			sessionManager: SessionManager.inMemory(cwd),
		});
		assert.ok(child);
		assert.deepEqual(child.getActiveToolNames(), ["read"]);
		assert.equal(child.settingsManager, parent.settingsManager);
		assert.equal(await child.extensionRunner.createContext().ui.input("question"), "  inherited  ");
	} finally {
		child?.dispose();
		parent.dispose();
		rmSync(cwd, { recursive: true, force: true });
	}
});

// #3105: production workflow adapter preserves optional inheritance and manager cwd precedence.
test.each(["omitted", "undefined", "manager", "relative"] as const)(
	"workflow child configuration boundaries: %s",
	async (mode) => {
		const { buildRuntimeAdapters } = await import("../../packages/workflows/src/extension/wiring.js");
		const { getModel } = await import("@bastani/atomic-ai/compat");
		const cwd = mkdtempSync(join(tmpdir(), "atomic-child-options-"));
		const managerCwd = join(cwd, "manager");
		mkdirSync(managerCwd);
		const host = {
			input: async () => "  inherited\n",
			confirm: async () => false,
			select: async () => undefined,
			editor: async () => "",
			questionnaire: async () => ({ answers: [], cancelled: true }),
		};
		const { session: parent } = await createAgentSession({
			cwd,
			agentDir: join(cwd, "agent"),
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			thinkingLevel: "high",
			sessionManager: SessionManager.inMemory(cwd),
			settingsManager: SettingsManager.inMemory(),
			builtins: { subagents: false, intercom: false, mcp: false, "web-access": false },
			tools: ["read"],
			extensionBindings: { humanInput: host },
		});
		let child: typeof parent | undefined;
		try {
			const adapters = buildRuntimeAdapters(
				{ getChildSessionOptions: parent.extensionRunner.createContext().getChildSessionOptions },
				{
					createAgentSession: async (options) => {
						const result = await createAgentSession(options);
						child = result.session;
						return result as unknown as import("../../packages/workflows/src/runs/foreground/stage-runner.js").StageSessionCreateResult;
					},
				},
			);
			const options = Object.freeze({
				sessionManager: SessionManager.inMemory(mode === "manager" || mode === "relative" ? managerCwd : cwd),
				...(mode === "relative" ? { cwd: "." } : {}),
				...(mode === "undefined"
					? {
							model: undefined,
							modelRuntime: undefined,
							settingsManager: undefined,
							agentDir: undefined,
							thinkingLevel: undefined,
							tools: undefined,
							builtins: undefined,
							extensionBindings: Object.freeze({ humanInput: undefined }),
						}
					: {}),
			});
			await adapters.agentSession!.create(options, {
				runId: "configuration",
				stageId: mode,
				stageName: mode,
				executionMode: "interactive",
				signal: new AbortController().signal,
			});
			assert.ok(child);
			assert.equal(child.extensionRunner.createContext().cwd, mode === "manager" ? managerCwd : cwd);
			assert.equal(child.sessionManager, options.sessionManager);
			assert.equal(child.model, parent.model);
			assert.equal(child.thinkingLevel, parent.thinkingLevel);
			assert.equal(child.settingsManager, parent.settingsManager);
			assert.deepEqual(child.getActiveToolNames(), ["read"]);
			assert.equal(await child.extensionRunner.createContext().ui.input("question"), "  inherited\n");
			assert.equal(options.extensionBindings?.humanInput, undefined);
		} finally {
			await child?.dispose();
			await parent.dispose();
			rmSync(cwd, { recursive: true, force: true });
		}
	},
);

// #3105: exercise the real in-process runner, not its testSession stub.
test.each([false, true])(
	"subagent child uses the parent's model runtime and tool ceiling, fallback=%s",
	async (fallback) => {
		const { getModel, createAssistantMessageEventStream } = await import("@bastani/atomic-ai/compat");
		const { AuthStorage, ModelRuntime } = await import("../../packages/coding-agent/src/index.js");
		const { runSingleInProcess } = await import("../../packages/subagents/src/runs/foreground/inprocess-run-sync.js");
		const { clearSubagentControls } = await import("../../packages/subagents/src/runs/inprocess/control-registry.js");
		const cwd = mkdtempSync(join(tmpdir(), "atomic-real-child-"));
		const model = { ...getModel("anthropic", "claude-sonnet-4-5")!, provider: "child-parity" };
		const fallbackModel = { ...model, id: "child-fallback" };
		const requestedModels: string[] = [];
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		const observed: string[][] = [];
		runtime.registerProvider(model.provider, {
			api: model.api,
			baseUrl: model.baseUrl,
			apiKey: "child-fixture-key",
			models: [model, fallbackModel],
			streamSimple: (requestModel, context) => {
				requestedModels.push(requestModel.id);
				observed.push(getCurrentTools(context.messages).map((tool) => tool.name));
				const stream = createAssistantMessageEventStream();
				const message = {
					role: "assistant" as const,
					content: [{ type: "text" as const, text: "child complete" }],
					api: model.api,
					provider: model.provider,
					model: requestModel.id,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop" as const,
					timestamp: Date.now(),
				};
				if (fallback && requestModel.id === model.id) {
					const error = { ...message, stopReason: "error" as const, errorMessage: "model not found" };
					stream.push({ type: "error", reason: "error", error });
					stream.end(error);
					return stream;
				}
				stream.push({ type: "done", reason: "stop", message });
				stream.end(message);
				return stream;
			},
		});
		const { session: parent } = await createAgentSession({
			cwd,
			agentDir: join(cwd, "agent"),
			modelRuntime: runtime,
			model,
			settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }),
			sessionManager: SessionManager.inMemory(cwd),
			builtins: { subagents: false, intercom: false, mcp: false, "web-access": false },
			tools: ["read"],
			fallbackModels: fallback ? [`${model.provider}/${fallbackModel.id}`] : [],
		});
		try {
			const result = await runSingleInProcess(
				cwd,
				{
					name: "worker",
					description: "fixture",
					systemPrompt: "",
					systemPromptMode: "replace",
					inheritProjectContext: false,
					inheritSkills: false,
					source: "user",
					filePath: join(cwd, "worker.md"),
					tools: ["read", "bash", "intercom"],
				},
				"report",
				{
					cwd,
					runId: `parity-${parent.sessionManager.getSessionId()}`,
					sessionDir: join(cwd, "children"),
					testSession: false,
					currentModel: `${model.provider}/${model.id}`,
					resolveCandidateModel: () => ({ model }),
					getChildSessionOptions: parent.extensionRunner.createContext().getChildSessionOptions,
				},
			);
			assert.equal(result.status, "ok", JSON.stringify(result));
			assert.deepEqual(requestedModels, fallback ? [model.id, fallbackModel.id] : [model.id]);
			assert.deepEqual(
				observed,
				requestedModels.map(() => ["read"]),
			);
		} finally {
			parent.dispose();
			clearSubagentControls();
			runtime.unregisterProvider(model.provider);
			rmSync(cwd, { recursive: true, force: true });
		}
	},
);

// #3105: exercise the real child session, broker waiter and workflow host consumer.
const childHostBindingModes = [
	"override",
	"null",
	"withdrawn",
	"parent-rebind",
	"parent-change",
	"reuse-null",
	"reuse-direct",
	"reuse-reload",
	"inherit-reload",
] as const;
test.each(childHostBindingModes)(
	"stage questionnaire respects child host precedence and durable rebind: %s",
	async (mode) => {
		const { buildRuntimeAdapters } = await import("../../packages/workflows/src/extension/wiring.js");
		const { bindWorkflowHumanInput } = await import("../../packages/workflows/src/extension/workflow-human-input.js");
		const { store } = await import("../../packages/workflows/src/shared/store.js");
		const { stageUiBroker } = await import("../../packages/workflows/src/shared/stage-ui-broker.js");
		const { buildStagePromptAdapter } = await import("../../packages/workflows/src/shared/stage-prompt.js");
		const cwd = mkdtempSync(join(tmpdir(), "atomic-child-questionnaire-"));
		const params = {
			questions: [
				{ question: "Private decision", header: "Private", options: [{ label: "parent" }, { label: "child" }] },
			],
		};
		const calls: string[] = [];
		const identities: HostInputOptions[] = [];
		const answerReady = Promise.withResolvers<void>();
		const host = (label: string) => ({
			input: async () => "",
			select: async () => undefined,
			confirm: async () => false,
			editor: async () => "",
			questionnaire: async (_params: typeof params, identity: HostInputOptions) => {
				calls.push(label);
				identities.push(identity);
				if (mode === "parent-change") await answerReady.promise;
				return {
					cancelled: false,
					answers: [
						{ questionIndex: 0, question: params.questions[0]!.question, kind: "option" as const, answer: label },
					],
				};
			},
		});
		const original = host("child");
		const reuse = mode.startsWith("reuse-");
		const { session: parent } = await createAgentSession({
			cwd,
			agentDir: join(cwd, "agent"),
			sessionManager: SessionManager.inMemory(cwd),
			settingsManager: SettingsManager.inMemory(),
			builtins: { subagents: false, intercom: false, mcp: false, "web-access": false },
			tools: ["ask_user_question"],
			extensionBindings: { humanInput: reuse ? original : host("parent") },
		});
		const unbind = bindWorkflowHumanInput(
			store,
			parent.extensionRunner!.createContext() as unknown as import("../../packages/workflows/src/extension/workflow-human-input.js").WorkflowHumanInputContext,
		);
		const runId = `child-precedence-${crypto.randomUUID()}`;
		const stageId = "private";
		store.recordRunStart({
			id: runId,
			name: "precedence",
			inputs: {},
			status: "running",
			toolNodes: [],
			stages: [],
			startedAt: Date.now(),
		});
		store.recordStageStart(runId, { id: stageId, name: stageId, status: "running", parentIds: [], toolEvents: [] });
		const adapters = buildRuntimeAdapters(
			{ getChildSessionOptions: parent.extensionRunner!.createContext().getChildSessionOptions },
			{
				createAgentSession: async (options) =>
					(await createAgentSession(
						options,
					)) as unknown as import("../../packages/workflows/src/runs/foreground/stage-runner.js").StageSessionCreateResult,
			},
		);
		const result = await adapters.agentSession!.create(
			{
				sessionManager: SessionManager.inMemory(cwd),
				...(mode === "override" || mode === "null" || mode === "parent-change"
					? { extensionBindings: { humanInput: mode === "null" ? null : host("child") } }
					: {}),
			},
			{ runId, stageId, stageName: stageId, executionMode: "interactive", signal: new AbortController().signal },
		);
		const child = "session" in result ? result.session : result;
		let presentations = 0;
		const detachPresentation =
			mode === "parent-rebind" || mode === "inherit-reload" || reuse
				? () => {}
				: stageUiBroker.registerHost(runId, stageId, {
						showCustomUi: () => {
							presentations++;
						},
					});
		try {
			stageUiBroker.provideStagePrompt(
				runId,
				stageId,
				buildStagePromptAdapter("private-question", "ask_user_question", params, Date.now())!,
			);
			const session = child as import("../../packages/coding-agent/src/index.js").AgentSession;
			if (mode === "withdrawn") await session.bindExtensions({ humanInput: null });
			if (mode === "parent-rebind") await parent.bindExtensions({ humanInput: null });
			if (reuse) {
				await parent.bindExtensions({ humanInput: host("parent") });
				if (mode === "reuse-null") await session.bindExtensions({ humanInput: null });
				await session.bindExtensions({ humanInput: original });
				await session.bindExtensions({});
				if (mode === "reuse-reload") await session.reload();
			}
			if (mode === "inherit-reload") {
				await session.bindExtensions({});
				await session.reload();
				await parent.bindExtensions({ humanInput: host("child") });
			}
			const tool = session.agent.state.tools.find((entry) => entry.name === "ask_user_question")!;
			let settled = false;
			const pending = tool.execute("private-question", params, AbortSignal.timeout(5000)).then((reply) => {
				settled = true;
				return reply;
			});
			if (mode === "parent-change") {
				await vi.waitFor(() => assert.deepEqual(calls, ["child"]));
				await parent.bindExtensions({ humanInput: host("parent") });
				await new Promise<void>((resolve) => setImmediate(resolve));
				assert.equal(
					identities[0]!.signal.aborted,
					false,
					"parent rebinding must not retire an explicit child host request",
				);
				answerReady.resolve();
			} else if (mode !== "override" && !reuse && mode !== "inherit-reload") {
				await new Promise<void>((resolve) => setImmediate(resolve));
				assert.equal(settled, false, "withdrawal must leave the broker waiter pending");
				assert.deepEqual(calls, [], "the parent must not answer a withdrawn child request");
				assert.ok(stageUiBroker.peekStageQuestionnaire(runId, stageId));
				if (mode !== "parent-rebind") assert.equal(session.extensionRunner!.createContext().hasHumanInput, false);
				await (mode === "parent-rebind" ? parent : session).bindExtensions({ humanInput: host("child") });
			}
			const reply = await pending;
			assert.equal((reply.details as { answers: { answer: string }[] }).answers[0]!.answer, "child");
			assert.deepEqual(calls, ["child"]);
			assert.equal(presentations, 0, "an attached parent renderer must not bypass child host precedence");
			assert.equal(identities[0]!.sessionId, session.sessionId);
			assert.equal(identities[0]!.workflowRunId, runId);
			assert.equal(identities[0]!.workflowStageId, stageId);
		} finally {
			answerReady.resolve();
			detachPresentation();
			await child.dispose?.();
			unbind();
			await parent.dispose();
			rmSync(cwd, { recursive: true, force: true });
		}
	},
);

// #3105: the production controller must not launder fallback models into unrestricted primaries.
test("workflow fallback replacement enforces the inherited gate but explicit primary remains valid", async () => {
	const { getModel, createAssistantMessageEventStream } = await import("@bastani/atomic-ai/compat");
	const { AuthStorage, ModelRuntime } = await import("../../packages/coding-agent/src/index.js");
	const { buildRuntimeAdapters } = await import("../../packages/workflows/src/extension/wiring.js");
	const { createStageContext } = await import("../../packages/workflows/src/runs/foreground/stage-runner.js");
	const cwd = mkdtempSync(join(tmpdir(), "atomic-stage-fallback-policy-"));
	const primary = {
		...getModel("anthropic", "claude-sonnet-4-5")!,
		provider: "stage-inheritance-fixture",
		id: "primary",
	};
	const forbidden = { ...primary, id: "forbidden" };
	const allowed = { ...primary, id: "allowed" };
	const runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	const calls: string[] = [];
	const checked: string[] = [];
	runtime.registerProvider(primary.provider, {
		api: primary.api,
		baseUrl: primary.baseUrl,
		apiKey: "fixture-key",
		models: [primary, forbidden, allowed],
		streamSimple: (model) => {
			calls.push(model.id);
			const stream = createAssistantMessageEventStream();
			const fail = model.id === "primary";
			const message: import("@bastani/atomic-ai/compat").AssistantMessage = {
				role: "assistant",
				content: fail ? [] : [{ type: "text", text: model.id }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: fail ? "error" : "stop",
				...(fail ? { errorMessage: "model not found" } : {}),
				timestamp: Date.now(),
			};
			stream.push(
				fail ? { type: "error", reason: "error", error: message } : { type: "done", reason: "stop", message },
			);
			stream.end(message);
			return stream;
		},
	});
	const { session: parent } = await createAgentSession({
		cwd,
		agentDir: join(cwd, "agent"),
		sessionManager: SessionManager.inMemory(cwd),
		modelRuntime: runtime,
		model: primary,
		settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }),
		builtins: { subagents: false, intercom: false, mcp: false, "web-access": false },
		tools: [],
		fallbackModels: [],
		isFallbackModelAllowed: (model) => {
			checked.push(model.id);
			return model.id !== "forbidden";
		},
	});
	const adapters = buildRuntimeAdapters(
		{ getChildSessionOptions: parent.extensionRunner!.createContext().getChildSessionOptions },
		{
			createAgentSession: async (options) =>
				(await createAgentSession(
					options,
				)) as unknown as import("../../packages/workflows/src/runs/foreground/stage-runner.js").StageSessionCreateResult,
		},
	);
	const models = {
		listModels: async () =>
			[primary, forbidden, allowed].map((model) => ({
				id: model.id,
				provider: model.provider,
				fullId: `${model.provider}/${model.id}`,
				model,
			})),
	};
	const stage = createStageContext({
		stageId: "fallback",
		stageName: "fallback",
		runId: "policy",
		adapters,
		models,
		stageOptions: {
			model: primary,
			fallbackModels: [`${primary.provider}/forbidden`, `${primary.provider}/allowed`],
		},
	});
	const explicit = createStageContext({
		stageId: "explicit",
		stageName: "explicit",
		runId: "policy",
		adapters,
		models,
		stageOptions: { model: forbidden },
	});
	try {
		assert.equal(await stage.prompt("reply once"), "allowed");
		assert.deepEqual(calls, ["primary", "allowed"]);
		assert.ok(checked.includes("forbidden"));
		assert.ok(checked.includes("allowed"));
		assert.equal(await explicit.prompt("explicit primary"), "forbidden");
		assert.deepEqual(calls, ["primary", "allowed", "forbidden"]);
	} finally {
		await stage.__dispose();
		await explicit.__dispose();
		await parent.dispose();
		runtime.unregisterProvider(primary.provider);
		rmSync(cwd, { recursive: true, force: true });
	}
});
