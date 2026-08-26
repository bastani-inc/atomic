/**
 * Regression coverage: a fork-context subagent must start on the agent's
 * configured model.
 *
 * `buildModelCandidates` only ever produced `provider/model[:thinking]` strings,
 * and the string was handed to the attempt as `ModelCandidate.modelId` while
 * `ModelCandidate.model` and `ChildSpec.model` stayed `undefined`. The runner
 * then called `createAgentSession({ model: candidate.model ?? policy.model })`
 * with nothing, and `createAgentSession` falls back to the model persisted in
 * the session file. For a fork that file carries the PARENT's `model_change`
 * entries, so the parent's model silently won and the agent's declared model was
 * never used — observed as a child declaring `openai-codex/gpt-5.6-luna:max`
 * running every turn on the parent's `anthropic/claude-fable-5`.
 *
 * These tests pin the handoff at the seam that carried the defect: the
 * `ChildSpec` and `ModelCandidate` handed to `startAttempt`, which are the only
 * two values that reach `createAgentSession`'s `model` argument.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@bastani/pi-ai/compat";
import { afterAll, describe, test, vi } from "vitest";
import type { AgentConfig } from "../../packages/subagents/src/agents/agent-types.ts";
import type { AttemptOutcome, ChildSpec, ModelCandidate } from "../../packages/subagents/src/runs/inprocess/runner.ts";
import { createCandidateModelResolver } from "../../packages/subagents/src/shared/model-resolution.ts";

interface CapturedAttempt {
	spec: ChildSpec;
	candidate: ModelCandidate;
}

const harness = vi.hoisted(() => ({
	attempts: [] as { spec: unknown; candidate: unknown }[],
}));

/**
 * The control plane is the natives-backed admission door; this run needs only
 * the four calls `runSingleInProcess` makes around one attempt, so the double
 * records the attempt inputs and returns a settled outcome.
 */
vi.mock("../../packages/subagents/src/runs/inprocess/control-registry.ts", () => {
	const outcome = {
		status: "ok" as const,
		output: "done",
		envelope: "done",
		path: "child/0",
		stats: {
			sessionFile: undefined,
			sessionId: "test-session",
			userMessages: 1,
			assistantMessages: 1,
			toolCalls: 0,
			toolResults: 0,
			totalMessages: 2,
			tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			cost: 0,
		},
	};
	const control = {
		registerAgents: () => undefined,
		admitChildSession: (spec: unknown) => ({
			admitted: {
				identity: { path: "child/0", depth: 1 },
				spec,
				policy: { cwd: "" },
				sessionDir: "",
			},
		}),
		startAttempt: (admitted: { spec: unknown }, candidate: unknown) => {
			harness.attempts.push({ spec: admitted.spec, candidate });
			return {
				status: "running",
				promise: Promise.resolve(outcome as AttemptOutcome),
			};
		},
		registerAttempt: (_runId: string, _running: unknown) => undefined,
		continueDetached: () => undefined,
		deliverChildResult: async () => undefined,
		getDeliveredResult: () => undefined,
	};
	return { getOrCreateSubagentControl: () => control };
});

const { runSingleInProcess } = await import("../../packages/subagents/src/runs/foreground/inprocess-run-sync.ts");

const PARENT_MODEL_ID = "anthropic/claude-fable-5";
const CONFIGURED_MODEL_ID = "openai-codex/gpt-5.6-luna";

function model(provider: string, id: string): Model<Api> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider,
		baseUrl: `https://example.invalid/${provider}`,
		reasoning: true,
		input: ["text"],
		cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 64_000,
	};
}

const configuredModel = model("openai-codex", "gpt-5.6-luna");
const parentModel = model("anthropic", "claude-fable-5");

/** Stands in for `ctx.modelRegistry`, with both providers authenticated. */
const registry = {
	getAvailable: () => [configuredModel, parentModel],
	find: (provider: string, id: string) =>
		[configuredModel, parentModel].find((entry) => entry.provider === provider && entry.id === id),
	hasConfiguredAuth: () => true,
};

const roots: string[] = [];

function makeCwd(): string {
	const cwd = mkdtempSync(join(tmpdir(), "subagent-fork-model-"));
	roots.push(cwd);
	return cwd;
}

function agentConfig(overrides: Partial<AgentConfig>): AgentConfig {
	return {
		name: "worker",
		description: "worker",
		systemPromptMode: "append",
		inheritProjectContext: true,
		inheritSkills: true,
		systemPrompt: "worker",
		source: "user",
		filePath: "/tmp/worker.md",
		...overrides,
	} as AgentConfig;
}

async function runAndCapture(options: {
	agent: AgentConfig;
	modelOverride?: string;
	resolve?: boolean;
}): Promise<CapturedAttempt> {
	harness.attempts.length = 0;
	const cwd = makeCwd();
	await runSingleInProcess(cwd, options.agent, "do the thing", {
		cwd,
		runId: "run-1",
		testSession: { output: "done" },
		// A fork run reuses the parent's session file, which is exactly where the
		// parent's model was being restored from.
		sessionFile: join(cwd, "parent-session.jsonl"),
		availableModels: [
			{ provider: "openai-codex", id: "gpt-5.6-luna", fullId: CONFIGURED_MODEL_ID },
			{ provider: "anthropic", id: "claude-fable-5", fullId: PARENT_MODEL_ID },
		],
		knownModelProviders: ["openai-codex", "anthropic"],
		preferredModelProvider: "anthropic",
		currentModel: PARENT_MODEL_ID,
		...(options.modelOverride === undefined ? {} : { modelOverride: options.modelOverride }),
		...(options.resolve === false
			? {}
			: { resolveCandidateModel: createCandidateModelResolver(registry, "anthropic") }),
	});
	assert.equal(harness.attempts.length, 1, "exactly one attempt should start");
	const captured = harness.attempts[0]!;
	return { spec: captured.spec as ChildSpec, candidate: captured.candidate as ModelCandidate };
}

afterAll(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("fork-context subagent model selection", () => {
	test("the agent's configured model reaches the child session instead of the parent's", async () => {
		const { spec, candidate } = await runAndCapture({
			agent: agentConfig({ model: `${CONFIGURED_MODEL_ID}:max` }),
		});

		// `createAgentSession({ model: candidate.model ?? policy.model })` is the
		// only input that beats the model restored from the forked session file.
		assert.deepEqual(candidate.model, configuredModel);
		assert.deepEqual(spec.model, configuredModel);
		assert.notDeepEqual(candidate.model, parentModel);
		assert.equal(candidate.modelId, `${CONFIGURED_MODEL_ID}:max`);
	});

	test("the thinking level in the candidate suffix is applied to the child session", async () => {
		const { spec, candidate } = await runAndCapture({
			agent: agentConfig({ model: `${CONFIGURED_MODEL_ID}:max`, thinking: "low" }),
		});

		assert.equal(spec.thinkingLevel, "max");
		assert.equal(candidate.thinkingLevel, "max");
	});

	test("an explicit model override wins on the first attempt", async () => {
		const { spec, candidate } = await runAndCapture({
			agent: agentConfig({ model: PARENT_MODEL_ID }),
			modelOverride: `${CONFIGURED_MODEL_ID}:max`,
		});

		assert.deepEqual(candidate.model, configuredModel);
		assert.deepEqual(spec.model, configuredModel);
	});

	test("an unresolvable candidate leaves the model unset rather than failing the run", async () => {
		const { spec, candidate } = await runAndCapture({
			agent: agentConfig({ model: "unknown-provider/absent-model" }),
		});

		assert.equal(candidate.model, undefined);
		assert.equal(spec.model, undefined);
		assert.equal(candidate.modelId, "unknown-provider/absent-model");
	});

	test("a host that supplies no resolver keeps the previous behavior", async () => {
		const { spec, candidate } = await runAndCapture({
			agent: agentConfig({ model: CONFIGURED_MODEL_ID }),
			resolve: false,
		});

		assert.equal(candidate.model, undefined);
		assert.equal(spec.model, undefined);
	});
});
