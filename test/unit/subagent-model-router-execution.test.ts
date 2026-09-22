// #3090: public single/parallel execution door, mock inference and child runtime only.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@bastani/atomic";
import { createAssistantMessageEventStream } from "@bastani/pi-ai";
import { afterEach, beforeEach, test, vi } from "vitest";
import { AgentTaskHost } from "../../packages/coding-agent/src/core/tasks/agent-adapter.js";
import { loadAgentsFromDirWithDiagnostics } from "../../packages/subagents/src/agents/agent-loaders.js";
import type { AgentConfig } from "../../packages/subagents/src/agents/agents.js";
import { createSubagentExecutor } from "../../packages/subagents/src/runs/foreground/subagent-executor.js";
import type {
	ExecutorDeps,
	SubagentParamsLike,
} from "../../packages/subagents/src/runs/foreground/subagent-executor-types.js";
import type { RunSyncOptions, SingleResult } from "../../packages/subagents/src/shared/types.js";
import {
	decisionMessage,
	decisionModel,
	messageStream,
	parseInferenceUserPayload,
	registeredDecisionRuntime,
} from "../helpers/structured-output.js";

const dirs: string[] = [];
beforeEach(() => vi.stubEnv("TYPESAFE_API_KEY", ""));
afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
async function fixture(model?: string) {
	const cwd = mkdtempSync(join(tmpdir(), "atomic-auto-router-"));
	dirs.push(cwd);
	const agent: AgentConfig = {
		name: "worker",
		description: "Implement approved changes",
		model,
		systemPrompt: "Self-contained task: review only",
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
		source: "project",
		filePath: join(cwd, "worker.md"),
	};
	const infer = vi.fn<Parameters<typeof registeredDecisionRuntime>[0]>(() =>
		messageStream(decisionMessage({ model: "decision-test/chat", effort: null })),
	);
	const { registry } = await registeredDecisionRuntime(infer);
	const runSync = vi.fn(
		async (
			_cwd: string,
			_agents: AgentConfig[],
			_name: string,
			task: string,
			_options: RunSyncOptions,
		): Promise<SingleResult> => ({
			agent: "worker",
			task,
			status: "ok",
			messages: [],
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
			finalOutput: "done",
		}),
	);
	const ctx = {
		cwd,
		model: decisionModel,
		thinkingLevel: "low",
		modelRegistry: registry,
		getRouterModel: () => "decision-test/chat",
		sessionManager: {
			getSessionFile: () => join(cwd, "session.jsonl"),
			getSessionId: () => "parent",
			getLeafId: () => null,
		},
		isProjectTrusted: () => true,
		hasUI: false,
	} as unknown as ExtensionContext;
	const executor = createSubagentExecutor({
		pi: {
			events: { on: () => () => {}, emit: () => {} },
			getSessionName: () => "parent",
		} as unknown as ExecutorDeps["pi"],
		state: {
			baseCwd: "",
			currentSessionId: null,
			subagentInProgress: false,
			foregroundControls: new Map(),
			lastForegroundControlId: null,
			pendingForegroundControlNotices: new Map(),
			lastUiContext: null,
		},
		config: { intercomBridge: { mode: "off" }, parallel: { concurrency: 4, maxTasks: 50 } },
		tempArtifactsDir: join(cwd, "artifacts"),
		getSubagentSessionRoot: () => join(cwd, "sessions"),
		expandTilde: (value) => value,
		discoverAgents: () => ({ agents: [agent] }),
		runtime: { runSync },
	});
	return {
		agent,
		ctx,
		infer,
		runSync,
		call: (params: SubagentParamsLike, signal = new AbortController().signal) =>
			executor.execute("auto-test", params, signal, undefined, ctx),
	};
}
for (const mode of ["single-explicit", "single-default", "parallel-explicit", "parallel-default"] as const) {
	test(`${mode} routes effective auto before child admission`, async () => {
		const f = await fixture(mode.endsWith("default") ? "auto" : undefined);
		const explicit = mode.endsWith("explicit") ? { model: "auto" } : {};
		const params = mode.startsWith("single")
			? { agent: "worker", task: "Inspect this patch", ...explicit }
			: { tasks: [{ agent: "worker", task: "Inspect this patch", ...explicit }] };
		const entered = Promise.withResolvers<void>();
		const stream = createAssistantMessageEventStream();
		f.infer.mockImplementation(() => {
			entered.resolve();
			return stream;
		});
		const pending = f.call(params);
		await entered.promise;
		assert.equal(f.runSync.mock.calls.length, 0);
		stream.push({
			type: "done",
			reason: "toolUse",
			message: decisionMessage({ model: "decision-test/chat", effort: null }),
		});
		const result = await pending;
		assert.notEqual(result.isError, true);
		assert.equal(f.runSync.mock.calls.length, 1);
		const options = f.runSync.mock.calls[0]![4];
		assert.equal(options.modelOverride, "decision-test/chat");
		assert.deepEqual(options.modelRoute?.routerSelection, { model: "decision-test/chat", effort: null });
	});
}
test("discovered builtin defaults route on single and parallel execution without a model argument", async () => {
	const { agents } = loadAgentsFromDirWithDiagnostics(join(process.cwd(), "packages/subagents/agents"), "builtin");
	const worker = agents.find((candidate) => candidate.name === "worker");
	assert.ok(worker);
	for (const parallel of [false, true]) {
		const f = await fixture();
		Object.assign(f.agent, worker);
		const task = { agent: "worker", task: "Inspect the approved patch", context: "fresh" as const };
		const result = await f.call(parallel ? { tasks: [task], context: "fresh" } : task);
		assert.notEqual(result.isError, true, JSON.stringify(result));
		assert.equal(f.infer.mock.calls.length, 1);
		assert.equal(f.runSync.mock.calls[0]?.[4].modelOverride, "decision-test/chat");
		assert.equal(f.ctx.model, decisionModel);
		await f.call({ ...task, model: "decision-test/chat:off" });
		assert.equal(f.infer.mock.calls.length, 1);
		assert.equal(f.runSync.mock.calls[1]?.[4].modelOverride, "decision-test/chat:off");
	}
});

test("concrete overrides and ordinary omission bypass inference with existing effort intact", async () => {
	const f = await fixture("auto");
	await f.call({ agent: "worker", task: "Inspect", model: "decision-test/chat:off" });
	assert.equal(f.infer.mock.calls.length, 0);
	assert.equal(f.runSync.mock.calls[0]![4].modelOverride, "decision-test/chat:off");
	f.agent.model = undefined;
	await f.call({ agent: "worker", task: "Inspect" });
	assert.equal(f.infer.mock.calls.length, 0);
	assert.equal(f.runSync.mock.calls[1]![4].modelOverride, undefined);
});
test("parallel tasks do not share the first decision", async () => {
	const f = await fixture("auto");
	const second = { ...decisionModel, id: "other" };
	vi.spyOn(f.ctx.modelRegistry, "getAvailable").mockReturnValue([decisionModel, second]);
	f.infer.mockImplementation((_model, context) => {
		const { state, questions } = parseInferenceUserPayload(context);
		const candidates = Object.values(questions?.pair?.criteria ?? {}).map((entry) => JSON.parse(entry as string));
		const preferred = (state?.task ?? "").includes("second") ? "decision-test/other" : "decision-test/chat";
		return messageStream(
			decisionMessage({
				model: candidates.find((pair) => pair.model === preferred)?.model ?? candidates[0].model,
				effort: null,
			}),
		);
	});
	await f.call({
		tasks: [
			{ agent: "worker", task: "first task" },
			{ agent: "worker", task: "second task" },
		],
	});
	assert.deepEqual(
		f.runSync.mock.calls.map((call) => call[4].modelOverride),
		["decision-test/chat", "decision-test/other"],
	);
	assert.equal(f.infer.mock.calls.length, 4);
});
test("invalid routing degrades to the current chat model; conflicting constraints produce no child runs (#3206)", async () => {
	const f = await fixture("auto");
	vi.spyOn(console, "warn").mockImplementation(() => {});
	f.infer.mockImplementation(() => messageStream(decisionMessage({ model: "auto", effort: null })));
	// #3206: the total routing-inference failure runs the child on the current chat model.
	const degraded = await f.call({ agent: "worker", task: "Inspect" });
	assert.equal(degraded.isError ?? false, false);
	assert.equal(f.runSync.mock.calls.length, 1);
	assert.equal(f.runSync.mock.calls[0]![4].modelOverride, "decision-test/chat");
	// Conflicting constraints are a validation failure, not an inference failure.
	f.agent.modelConstraints = { allowedModels: ["private/model"] };
	const denied = await f.call({
		agent: "worker",
		task: "Inspect",
		modelConstraints: { allowedModels: ["decision-test/chat"] },
	});
	assert.equal(denied.isError, true);
	assert.equal(f.runSync.mock.calls.length, 1);
});
test("router cancellation cannot admit a child through a late result", async () => {
	const f = await fixture("auto");
	const controller = new AbortController();
	const entered = Promise.withResolvers<void>();
	const stream = createAssistantMessageEventStream();
	f.infer.mockImplementation(() => {
		entered.resolve();
		return stream;
	});
	const pending = f.call({ agent: "worker", task: "Inspect" }, controller.signal);
	await entered.promise;
	controller.abort();
	stream.push({
		type: "done",
		reason: "toolUse",
		message: decisionMessage({ model: "decision-test/chat", effort: null }),
	});
	await pending;
	assert.equal(f.runSync.mock.calls.length, 0);
});

test("host status retains immutable original selection separately from actual fallback model and effort", async () => {
	const f = await fixture("auto");
	const host = new AgentTaskHost({ scope: { kind: "session", sessionId: randomUUID() }, authorizeLaunch() {} });
	f.ctx.getAgentTaskHost = () => host;
	f.runSync.mockImplementation(async (_cwd, _agents, _name, task) => ({
		agent: "worker",
		task,
		status: "ok",
		model: "fallback/model",
		thinking: "low",
		messages: [],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
		finalOutput: "done",
	}));
	try {
		const result = await f.call({ agent: "worker", task: "Inspect", wait: { kind: "foreground" } });
		assert.notEqual(result.isError, true);
		const watched = host.watchOwnerTasks();
		assert.ok(watched.ok);
		const record = watched.value.snapshot.tasks[0]!;
		assert.deepEqual(record.routerSelection, { model: "decision-test/chat", effort: null });
		assert.equal(Object.isFrozen(record.routerSelection), true);
		assert.equal(record.model, "fallback/model");
		assert.equal(record.thinking, "low");
		watched.value.dispose();
	} finally {
		await host.close("session-close");
	}
});
