/**
 * A provider content-filter refusal, such as OpenAI's HTTP 422 `cyber_policy`, is a verdict on the request for that
 * model: sending it again gets the same refusal. It spends the next `fallbackModels` candidate at once, for workflow
 * stages and for subagents, and `retry.fallbackOnContentFilter: false` keeps the refusal on the model that gave it.
 * Real AgentSessions against local providers; no network is contacted.
 */

import "../helpers/provider-rate-limit-isolation.js";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Api, type AssistantMessage, createAssistantMessageEventStream, type Model } from "@bastani/pi-ai/compat";
import { afterEach, describe, test } from "vitest";
import {
	isRetryableModelFailure,
	normalizeModelFailureSignal,
} from "../../packages/coding-agent/src/core/model-fallback-failures.js";
import { createAgentSession } from "../../packages/coding-agent/src/core/sdk.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import { AuthStorage, ModelRuntime } from "../../packages/coding-agent/src/index.js";
import { createTestResourceLoader } from "../../packages/coding-agent/test/utilities.js";
import type { AgentConfig } from "../../packages/subagents/src/agents/agent-types.js";
import { runSingleInProcess } from "../../packages/subagents/src/runs/foreground/inprocess-run-sync.js";
import { clearSubagentControls } from "../../packages/subagents/src/runs/inprocess/control-registry.js";
import { createCandidateModelResolver } from "../../packages/subagents/src/shared/model-resolution.js";
import type { StageSessionRuntime } from "../../packages/workflows/src/runs/foreground/stage-runner-types.js";
import {
	type AgentSessionAdapter,
	createStageContext,
	type InternalStageContext,
	makeOpts,
} from "./stage-runner-helpers.js";

/** Structural cost, not a slow test: each case builds real AgentSessions, and a subagent case a real child session. */
const REAL_SESSION_TIMEOUT_MS = 90_000;

/** Same-model retries the fixtures allow, so a refusal that is retried on its own model shows extra requests. */
const MAX_RETRIES = 2;

/** How the refusal reaches Atomic from each provider path that sends one. */
const REFUSALS = [
	// ChatGPT (Codex) responses keep the HTTP status and the error's message, not its code.
	{
		label: "ChatGPT 422 cyber_policy",
		errorMessage: "422: This content was flagged for possible cybersecurity risk.",
	},
	// The OpenAI SDK keeps the status and the JSON error body.
	{
		label: "OpenAI API 422 cyber_policy",
		errorMessage:
			'422: {"message":"This content was flagged for possible cybersecurity risk.","type":"invalid_request","param":null,"code":"cyber_policy"}',
	},
	// Anthropic's refusal stop carries its explanation.
	{
		label: "Anthropic refusal stop",
		errorMessage:
			"This request triggered restrictions on violative cyber content and was blocked under Anthropic's Usage Policy.",
	},
	{ label: "OpenAI-compatible content_filter finish", errorMessage: "Provider finish_reason: content_filter" },
] as const;

const spec = {
	id: "m",
	name: "m",
	reasoning: false,
	input: ["text"] as ("text" | "image")[],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100_000,
	maxTokens: 1000,
};

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function reply(model: Pick<Model<Api>, "api" | "provider" | "id">, failure?: string) {
	const stream = createAssistantMessageEventStream();
	const message: AssistantMessage = {
		role: "assistant",
		content: failure === undefined ? [{ type: "text", text: "ok" }] : [],
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
		stopReason: failure === undefined ? "stop" : "error",
		timestamp: Date.now(),
		...(failure === undefined ? {} : { errorMessage: failure }),
	};
	stream.push({ type: "start", partial: message });
	if (failure === undefined) stream.push({ type: "done", reason: "stop", message });
	else stream.push({ type: "error", reason: "error", error: message });
	stream.end(message);
	return stream;
}

/** A `refusing` provider that answers every request with `refusal`, and a `spare` provider that answers "ok". */
async function providers(refusal: string) {
	const calls: Record<string, number> = {};
	const runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory({
			refusing: { type: "api_key", key: "x" },
			spare: { type: "api_key", key: "x" },
		}),
		modelsPath: null,
		refreshOnCreate: false,
	});
	for (const provider of ["refusing", "spare"]) {
		runtime.registerProvider(provider, {
			api: "openai-completions",
			baseUrl: "https://example.invalid",
			apiKey: "x",
			models: [spec],
			streamSimple: (model) => {
				calls[provider] = (calls[provider] ?? 0) + 1;
				return reply(model, provider === "refusing" ? refusal : undefined);
			},
		});
	}
	return { runtime, calls };
}

function retrySettings(fallbackOnContentFilter: boolean | undefined) {
	return SettingsManager.inMemory({
		retry: {
			enabled: true,
			maxRetries: MAX_RETRIES,
			baseDelayMs: 1,
			...(fallbackOnContentFilter === undefined ? {} : { fallbackOnContentFilter }),
		},
		compaction: { enabled: false },
	});
}

async function stagePrompt(refusal: string, fallbackOnContentFilter?: boolean) {
	const { runtime, calls } = await providers(refusal);
	const sessions: StageSessionRuntime[] = [];
	cleanups.push(async () => {
		for (const session of sessions) await session.dispose();
	});
	const agentSession: AgentSessionAdapter = {
		async create(options) {
			const requested =
				typeof options.model === "string" ? String(options.model).split("/")[0]! : options.model!.provider;
			const { session } = await createAgentSession({
				cwd: process.cwd(),
				agentDir: process.cwd(),
				builtins: { workflows: false, subagents: false, intercom: false, mcp: false, "web-access": false },
				modelRuntime: runtime,
				model: runtime.getModel(requested, "m")!,
				fallbackModels: options.fallbackModels,
				settingsManager: retrySettings(fallbackOnContentFilter),
				sessionManager: SessionManager.inMemory(),
				resourceLoader: createTestResourceLoader(),
			});
			sessions.push(session as unknown as StageSessionRuntime);
			return session as unknown as StageSessionRuntime;
		},
	};
	const ctx = createStageContext(
		makeOpts({
			adapters: { agentSession },
			stageOptions: { model: "refusing/m", fallbackModels: ["spare/m"] },
		}),
	) as InternalStageContext;
	cleanups.push(() => ctx.abort());
	const outcome = await ctx.prompt("go").then(
		(text) => ({ text }),
		(error: unknown) => ({ error }),
	);
	return { outcome, calls, meta: ctx.__modelFallbackMeta() };
}

/** A refused tool call is about that call, not the request's content: another model gets the same tool call. */
const TOOL_REFUSALS = [
	"tool call refused by provider due to safety policy",
	"safety policy: tool call refused by provider",
	"Provider refused the tool call under its content policy",
	"tool_use refused: blocked by safety filter",
] as const;

/** Content-filter refusals that mention no tool call. */
const CONTENT_FILTER_ONLY = [
	...REFUSALS.map(({ errorMessage }) => errorMessage),
	"request blocked by safety policy",
	"provider refused this request",
] as const;

describe("a refused tool call is not a content-filter refusal", () => {
	test.each(TOOL_REFUSALS)("%s stays a tool refusal and spends no fallback candidate", (errorMessage) => {
		const failure = { role: "assistant", stopReason: "error", errorMessage };
		assert.equal(normalizeModelFailureSignal(failure).kind, "task_failure");
		assert.equal(isRetryableModelFailure(failure), false);
	});

	test.each(CONTENT_FILTER_ONLY)("%s is a content-filter refusal", (errorMessage) => {
		const failure = { role: "assistant", stopReason: "error", errorMessage };
		assert.equal(normalizeModelFailureSignal(failure).kind, "content_filter");
		assert.equal(isRetryableModelFailure(failure), true);
	});

	test("a refusal code names a tool refusal before any policy word, and a content filter otherwise", () => {
		for (const code of [
			"tool_call_refusal",
			"tool_use_refusal",
			"tool_use_refused_by_policy",
			"TOOL_REFUSAL_SAFETY",
		]) {
			const failure = { stopReason: "error", code, message: "localized provider text" };
			assert.equal(normalizeModelFailureSignal(failure).kind, "task_failure", code);
			assert.equal(isRetryableModelFailure(failure), false, code);
		}
		for (const code of ["cyber_policy", "content_filter", "blocked_by_safety", "refusal"]) {
			const failure = { stopReason: "error", code, message: "localized provider text" };
			assert.equal(normalizeModelFailureSignal(failure).kind, "content_filter", code);
			assert.equal(isRetryableModelFailure(failure), true, code);
		}
	});

	test(
		"a workflow stage whose tool call is refused under a safety policy does not move to its fallback model",
		async () => {
			const { outcome, calls } = await stagePrompt(TOOL_REFUSALS[0]);

			assert.ok("error" in outcome, "the refused tool call is the stage's failure");
			assert.equal(calls.spare, undefined, "no fallback candidate was asked");
		},
		REAL_SESSION_TIMEOUT_MS,
	);
});

describe("workflow stage fallbackModels on a content-filter refusal", () => {
	test.each(REFUSALS)(
		"$label spends the next candidate without retrying the refusing model, and records the refusal",
		async ({ errorMessage }) => {
			const { outcome, calls, meta } = await stagePrompt(errorMessage);

			assert.deepEqual(outcome, { text: "ok" });
			assert.deepEqual(calls, { refusing: 1, spare: 1 });
			assert.deepEqual(
				meta.modelAttempts?.map(({ model, success, error }) => ({ model, success, error })),
				[
					{ model: "refusing/m", success: false, error: errorMessage },
					{ model: "spare/m", success: true, error: undefined },
				],
			);
		},
		REAL_SESSION_TIMEOUT_MS,
	);

	test(
		"retry.fallbackOnContentFilter: false keeps the refusal on the model that gave it",
		async () => {
			const { outcome, calls } = await stagePrompt(REFUSALS[0].errorMessage, false);

			assert.ok("error" in outcome, "the refusal is the stage's failure");
			assert.match(String(outcome.error), /cybersecurity risk/);
			assert.equal(calls.spare, undefined, "no fallback candidate was asked");
		},
		REAL_SESSION_TIMEOUT_MS,
	);
});

async function subagentRun(refusal: string, fallbackOnContentFilter?: boolean) {
	const { runtime, calls } = await providers(refusal);
	const cwd = mkdtempSync(join(tmpdir(), "atomic-content-filter-fallback-"));
	cleanups.push(() => rmSync(cwd, { recursive: true, force: true }));
	const { session: parent } = await createAgentSession({
		cwd,
		agentDir: join(cwd, "agent"),
		modelRuntime: runtime,
		model: runtime.getModel("spare", "m")!,
		settingsManager: retrySettings(fallbackOnContentFilter),
		sessionManager: await SessionManager.create(cwd, join(cwd, "parent-sessions")),
		builtins: { workflows: false, subagents: false, intercom: false, mcp: false, "web-access": false },
		tools: ["read"],
	});
	cleanups.push(() => {
		parent.dispose();
		clearSubagentControls();
	});
	const catalog = [runtime.getModel("refusing", "m")!, runtime.getModel("spare", "m")!];
	const agent: AgentConfig = {
		name: "worker",
		description: "content-filter fixture",
		systemPrompt: "",
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
		source: "user",
		filePath: join(cwd, "worker.md"),
		tools: ["read"],
		model: "refusing/m",
		fallbackModels: ["spare/m"],
	};
	const result = await runSingleInProcess(cwd, agent, "reply ok", {
		cwd,
		runId: "content-filter-fallback",
		index: 0,
		sessionDir: join(cwd, "children"),
		testSession: false,
		knownModelProviders: ["refusing", "spare"],
		currentModel: "spare/m",
		availableModels: catalog.map((entry) => ({
			provider: entry.provider,
			id: entry.id,
			fullId: `${entry.provider}/${entry.id}`,
		})),
		resolveCandidateModel: createCandidateModelResolver({
			getAvailable: () => catalog,
			find: (provider, id) => catalog.find((entry) => entry.provider === provider && entry.id === id),
			hasConfiguredAuth: () => true,
		}),
		getChildSessionOptions: parent.extensionRunner.createContext().getChildSessionOptions,
	});
	return { result, calls };
}

describe("subagent fallbackModels on a content-filter refusal", () => {
	test.each(REFUSALS)(
		"$label spends the next candidate without retrying the refusing model",
		async ({ errorMessage }) => {
			const { result, calls } = await subagentRun(errorMessage);

			assert.equal(result.status, "ok", JSON.stringify(result));
			assert.deepEqual(calls, { refusing: 1, spare: 1 });
			assert.equal(result.model, "spare/m");
			assert.deepEqual(result.attemptedModels, ["refusing/m", "spare/m"]);
		},
		REAL_SESSION_TIMEOUT_MS,
	);

	test(
		"retry.fallbackOnContentFilter: false keeps the refusal on the model that gave it",
		async () => {
			const { result, calls } = await subagentRun(REFUSALS[0].errorMessage, false);

			assert.equal(result.status, "error", JSON.stringify(result));
			assert.equal(calls.spare, undefined, "no fallback candidate was asked");
		},
		REAL_SESSION_TIMEOUT_MS,
	);
});
