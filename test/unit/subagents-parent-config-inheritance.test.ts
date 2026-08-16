/**
 * Pi 0.84.2 parity audit (upstream e3798ca9, "inherit subagent session
 * config", #7897): a subagent dispatched by a session runs, unless its own
 * definition says otherwise, on that session's model, thinking level, and
 * tool configuration. Atomic ships `@bastani/subagents` instead of upstream's
 * example extension, so the parity claims are pinned here against Atomic's
 * own dispatch seam.
 *
 * Model inheritance was already structural — the parent's model is the
 * trailing candidate in `buildModelCandidates` — but the parent's thinking
 * level never reached the child spec: `spec.thinkingLevel` fell back from the
 * candidate suffix straight to `agent.thinking`, so an agent without a model
 * of its own started on the child's settings default instead of the
 * dispatching session's level. The fix threads `currentThinkingLevel` through
 * `RunSyncOptions` and applies it under the same condition upstream uses:
 * only when nothing the agent configured names a model — no frontmatter
 * `model`, no `fallbackModels` (whose chain outranks the parent's model in
 * `buildModelCandidates`), and no per-call override.
 *
 * Tool configuration is pinned too: an agent that omits `tools` must leave
 * the child's spec without an allowlist so `createAgentSession` keeps its
 * default tool set (upstream's no-`--tools` child), while an agent that
 * declares `tools` produces exactly that allowlist.
 *
 * The assertions sit on the `ChildSpec` handed to `startAttempt` — the last
 * value shaped by dispatch before the runner builds the child session.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { afterAll, describe, test, vi } from "vitest";
import type { AgentConfig } from "../../packages/subagents/src/agents/agent-types.ts";
import type { AttemptOutcome, ChildSpec, ModelCandidate } from "../../packages/subagents/src/runs/inprocess/runner.ts";
import { createCandidateModelResolver } from "../../packages/subagents/src/shared/model-resolution.ts";

const harness = vi.hoisted(() => ({
	attempts: [] as { spec: unknown; candidate: unknown }[],
}));

/**
 * The natives-backed control plane is reduced to the four calls
 * `runSingleInProcess` makes around one attempt; the double records the
 * attempt inputs and returns a settled outcome.
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
		registerNestedAttempt: () => undefined,
		continueDetached: () => undefined,
		deliverChildResult: async () => undefined,
		getDeliveredResult: () => undefined,
	};
	return { getOrCreateSubagentControl: () => control };
});

const { runSingleInProcess } = await import("../../packages/subagents/src/runs/foreground/inprocess-run-sync.ts");

const PARENT_MODEL_ID = "anthropic/claude-fable-5";
const CONFIGURED_MODEL_ID = "openai-codex/gpt-5.6-luna";
const PARENT_THINKING_LEVEL = "high";

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
	const cwd = mkdtempSync(join(tmpdir(), "subagent-inherit-"));
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

async function dispatchAndCapture(options: {
	agent: AgentConfig;
	modelOverride?: string;
	thinking?: string;
}): Promise<{ spec: ChildSpec; candidate: ModelCandidate }> {
	harness.attempts.length = 0;
	const cwd = makeCwd();
	await runSingleInProcess(cwd, options.agent, "do the thing", {
		cwd,
		runId: "run-1",
		testSession: { output: "done" },
		availableModels: [
			{ provider: "openai-codex", id: "gpt-5.6-luna", fullId: CONFIGURED_MODEL_ID },
			{ provider: "anthropic", id: "claude-fable-5", fullId: PARENT_MODEL_ID },
		],
		knownModelProviders: ["openai-codex", "anthropic"],
		preferredModelProvider: "anthropic",
		currentModel: PARENT_MODEL_ID,
		...(options.thinking === undefined ? {} : { currentThinkingLevel: options.thinking }),
		...(options.modelOverride === undefined ? {} : { modelOverride: options.modelOverride }),
		resolveCandidateModel: createCandidateModelResolver(registry, "anthropic"),
	});
	assert.equal(harness.attempts.length, 1, "exactly one attempt should start");
	const captured = harness.attempts[0]!;
	return { spec: captured.spec as ChildSpec, candidate: captured.candidate as ModelCandidate };
}

afterAll(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("subagent inherits the dispatching session's configuration", () => {
	test("an agent without a model inherits the parent session's model and thinking level", async () => {
		const { spec, candidate } = await dispatchAndCapture({
			agent: agentConfig({}),
			thinking: PARENT_THINKING_LEVEL,
		});

		// The parent's model is the inherited candidate and reaches the child
		// session as a resolved Model, not just a candidate string.
		assert.equal(candidate.modelId, PARENT_MODEL_ID);
		assert.deepEqual(candidate.model, parentModel);
		assert.deepEqual(spec.model, parentModel);
		// The parent's active thinking level rides along with the inherited
		// model, exactly as upstream's dispatchDefaults does.
		assert.equal(spec.thinkingLevel, PARENT_THINKING_LEVEL);
	});

	test("an agent that pins its own model does not inherit the parent's thinking level", async () => {
		const { spec } = await dispatchAndCapture({
			agent: agentConfig({ model: CONFIGURED_MODEL_ID }),
			thinking: PARENT_THINKING_LEVEL,
		});

		assert.deepEqual(spec.model, configuredModel);
		// Upstream gates inheritance on `!agent.model`; a child dispatched onto
		// a different model keeps that model's own thinking configuration.
		assert.equal(spec.thinkingLevel, undefined);
	});

	test("an agent whose fallback chain selects its own model does not inherit the thinking level", async () => {
		const { spec, candidate } = await dispatchAndCapture({
			agent: agentConfig({ fallbackModels: [CONFIGURED_MODEL_ID] }),
			thinking: PARENT_THINKING_LEVEL,
		});

		// `buildModelCandidates` orders [primary, ...fallbacks, parent], so an
		// agent with fallbackModels and no primary runs on its own first
		// fallback — the parent's model is never selected. The child therefore
		// keeps its own thinking configuration: leaking the parent's level
		// here is the same defect as leaking it for a declared `model`.
		assert.equal(candidate.modelId, CONFIGURED_MODEL_ID);
		assert.deepEqual(spec.model, configuredModel);
		assert.equal(spec.thinkingLevel, undefined);
	});

	test("the agent's declared thinking wins over the inherited level", async () => {
		const { spec } = await dispatchAndCapture({
			agent: agentConfig({ thinking: "low" }),
			thinking: PARENT_THINKING_LEVEL,
		});

		assert.equal(spec.thinkingLevel, "low");
	});

	test("a caller-supplied model override blocks thinking-level inheritance", async () => {
		const { spec } = await dispatchAndCapture({
			agent: agentConfig({}),
			modelOverride: CONFIGURED_MODEL_ID,
			thinking: PARENT_THINKING_LEVEL,
		});

		assert.deepEqual(spec.model, configuredModel);
		// An explicit per-call model is a pinned model: no dispatch-config
		// inheritance applies.
		assert.equal(spec.thinkingLevel, undefined);
	});

	test("an agent that omits tools leaves the child on the default tool configuration", async () => {
		const { spec } = await dispatchAndCapture({ agent: agentConfig({}) });

		// `tools: undefined` is what `createAgentSession` maps to the default
		// tool set; an empty array here would mean a child with no tools.
		assert.equal(spec.tools, undefined);
	});

	test("an agent that declares tools produces exactly that allowlist", async () => {
		const { spec } = await dispatchAndCapture({ agent: agentConfig({ tools: ["read", "bash"] }) });

		assert.deepEqual(spec.tools, ["read", "bash"]);
	});
});
