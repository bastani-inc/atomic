import assert from "node:assert/strict";
import { type AssistantMessage, createAssistantMessageEventStream } from "@bastani/pi-ai/compat";
import { afterEach, beforeEach, test, vi } from "vitest";
import { AuthStorage } from "../../packages/coding-agent/src/core/auth-storage.js";
import { ModelRuntime } from "../../packages/coding-agent/src/core/model-runtime.js";
import { createAgentSession } from "../../packages/coding-agent/src/core/sdk.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import { createTestResourceLoader } from "../../packages/coding-agent/test/utilities.js";
import type { StageSessionRuntime } from "../../packages/workflows/src/runs/foreground/stage-runner-types.js";
import {
	type AgentSessionAdapter,
	createStageContext,
	type InternalStageContext,
	makeOpts,
} from "./stage-runner-helpers.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const spec = {
	id: "m",
	name: "m",
	reasoning: false,
	input: ["text"] as ("text" | "image")[],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100_000,
	maxTokens: 1000,
};

function response(
	model: { api: AssistantMessage["api"]; provider: string; id: string },
	failure?: string,
): ReturnType<typeof createAssistantMessageEventStream> {
	const stream = createAssistantMessageEventStream();
	const msg: AssistantMessage = {
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
	stream.push({ type: "start", partial: msg });
	if (failure === undefined) stream.push({ type: "done", reason: "stop", message: msg });
	else stream.push({ type: "error", reason: "error", error: msg });
	stream.end(msg);
	return stream;
}

function realSessionContext(
	maxRetries: number,
	calls: Record<string, number>,
	withFallback: boolean,
	spareLimited = false,
) {
	const sessions: StageSessionRuntime[] = [];
	const agentSession: AgentSessionAdapter = {
		async create(options) {
			const modelRuntime = await ModelRuntime.create({
				credentials: AuthStorage.inMemory({
					limited: { type: "api_key", key: "x" },
					spare: { type: "api_key", key: "x" },
				}),
				modelsPath: null,
				refreshOnCreate: false,
			});
			modelRuntime.registerProvider("limited", {
				api: "openai-completions",
				baseUrl: "https://example.invalid",
				apiKey: "x",
				models: [spec],
				streamSimple: (model) => {
					calls.limited = (calls.limited ?? 0) + 1;
					return response(model, "429 rate limit exceeded");
				},
			});
			modelRuntime.registerProvider("spare", {
				api: "openai-completions",
				baseUrl: "https://example.invalid",
				apiKey: "x",
				models: [spec],
				streamSimple: (model) => {
					calls.spare = (calls.spare ?? 0) + 1;
					return response(model, spareLimited ? "429 rate limit exceeded" : undefined);
				},
			});
			const requested =
				typeof options.model === "string"
					? String(options.model).split("/")[0]!
					: (options.model?.provider ?? "limited");
			const { session } = await createAgentSession({
				cwd: process.cwd(),
				agentDir: process.cwd(),
				builtins: { workflows: false, subagents: false, intercom: false, mcp: false, "web-access": false },
				modelRuntime,
				model: modelRuntime.getModel(requested, "m")!,
				fallbackModels: options.fallbackModels,
				settingsManager: SettingsManager.inMemory({
					retry: { enabled: true, maxRetries, baseDelayMs: 10, maxAgentDelayMs: 60_000 },
					compaction: { enabled: false },
				}),
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
			stageOptions: { model: "limited/m", ...(withFallback ? { fallbackModels: ["spare/m"] } : {}) },
		}),
	) as InternalStageContext;
	return { ctx, sessions };
}

async function settle<T>(pending: Promise<T>): Promise<{ value: T } | { error: unknown }> {
	const settled = pending.then(
		(value) => ({ value }),
		(error: unknown) => ({ error }),
	);
	let done = false;
	void settled.then(() => {
		done = true;
	});
	// Bounded in fake time: a prompt that never settles fails here instead of hanging the test.
	for (let i = 0; i < 1_000 && !done; i++) await vi.advanceTimersByTimeAsync(5_000);
	assert.ok(done, "the prompt settles within the bounded cooldown budget");
	return settled;
}

// Each provider wait is capped at 60 s, so a walk of N provider calls never waits longer than N minutes.
const MAX_COOLDOWN_MS = 60_000;

test("a real AgentSession's rate-limited candidates get maxRetries+1 provider calls per cooldown round, not one cycle per revisit (#3864, #3984)", async () => {
	const calls: Record<string, number> = {};
	const { ctx, sessions } = realSessionContext(3, calls, true, true);
	const started = Date.now();
	try {
		const result = await settle(ctx.prompt("go"));
		assert.ok("error" in result, "every candidate stays limited, so the 429 surfaces once the rounds are spent");
		assert.match(String(result.error), /429/);
		// maxRetries+1 calls per candidate per round; the first round plus maxRetries whole-chain cooldown rounds.
		assert.deepEqual(calls, { limited: 16, spare: 16 });
		assert.ok(Date.now() - started <= 32 * MAX_COOLDOWN_MS);
	} finally {
		await ctx.abort();
		for (const session of sessions) await session.dispose();
	}
});

test("a real AgentSession's fallback takes over after the primary spends maxRetries+1 calls (#3864)", async () => {
	const calls: Record<string, number> = {};
	const { ctx, sessions } = realSessionContext(3, calls, true);
	try {
		const result = await settle(ctx.prompt("go"));
		assert.ok("value" in result, `expected fallback success, got ${String("error" in result ? result.error : "")}`);
		assert.deepEqual(calls, { limited: 4, spare: 1 });
	} finally {
		await ctx.abort();
		for (const session of sessions) await session.dispose();
	}
});

test("a real AgentSession without fallbacks stops after its cooldown rounds and surfaces the 429 (#3864, #3984)", async () => {
	const calls: Record<string, number> = {};
	const { ctx, sessions } = realSessionContext(3, calls, false);
	const started = Date.now();
	try {
		const result = await settle(ctx.prompt("go"));
		assert.ok("error" in result);
		assert.match(String(result.error), /429/);
		assert.deepEqual(calls, { limited: 16 });
		assert.ok(Date.now() - started <= 16 * MAX_COOLDOWN_MS);
	} finally {
		await ctx.abort();
		for (const session of sessions) await session.dispose();
	}
});
