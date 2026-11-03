/**
 * A workflow stage that owns its fallback chain gives a provider failure nothing recognizes its same-model retries
 * before it moves to the next candidate, and fails at once when it has no next candidate, as the main chat does with
 * its own chain (#4223). Real stage runner and AgentSessions against local providers; no network is contacted.
 */

import "../helpers/provider-rate-limit-isolation.js";
import assert from "node:assert/strict";
import { type Api, type AssistantMessage, createAssistantMessageEventStream, type Model } from "@bastani/pi-ai/compat";
import { afterEach, describe, test } from "vitest";
import { createAgentSession } from "../../packages/coding-agent/src/core/sdk.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import { AuthStorage, ModelRuntime } from "../../packages/coding-agent/src/index.js";
import { createTestResourceLoader } from "../../packages/coding-agent/test/utilities.js";
import type { StageSessionRuntime } from "../../packages/workflows/src/runs/foreground/stage-runner-types.js";
import {
	type AgentSessionAdapter,
	createStageContext,
	type InternalStageContext,
	makeOpts,
} from "./stage-runner-helpers.js";

/** Structural cost, not a slow test: each case builds real AgentSessions. */
const REAL_SESSION_TIMEOUT_MS = 90_000;

/** Same-model retries the fixtures allow, so a retried failure shows that many extra requests. */
const MAX_RETRIES = 2;

/** An error with no status or code, in words no classifier pattern recognizes. */
const UNRECOGNIZED = "the provider said something nobody has seen before";

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

/** A `failing` provider that answers every request with an unrecognized error, and a `spare` one that answers "ok". */
async function stagePrompt(stageOptions: { model: string; fallbackModels?: string[] }) {
	const calls: Record<string, number> = {};
	const runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory({
			failing: { type: "api_key", key: "x" },
			spare: { type: "api_key", key: "x" },
		}),
		modelsPath: null,
		refreshOnCreate: false,
	});
	for (const provider of ["failing", "spare"]) {
		runtime.registerProvider(provider, {
			api: "openai-completions",
			baseUrl: "https://example.invalid",
			apiKey: "x",
			models: [spec],
			streamSimple: (model) => {
				calls[provider] = (calls[provider] ?? 0) + 1;
				return reply(model, provider === "failing" ? UNRECOGNIZED : undefined);
			},
		});
	}
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
				settingsManager: SettingsManager.inMemory({
					retry: { enabled: true, maxRetries: MAX_RETRIES, baseDelayMs: 1 },
					compaction: { enabled: false },
				}),
				sessionManager: SessionManager.inMemory(),
				resourceLoader: createTestResourceLoader(),
			});
			sessions.push(session as unknown as StageSessionRuntime);
			return session as unknown as StageSessionRuntime;
		},
	};
	const ctx = createStageContext(makeOpts({ adapters: { agentSession }, stageOptions })) as InternalStageContext;
	cleanups.push(() => ctx.abort());
	const outcome = await ctx.prompt("go").then(
		(text) => ({ text }),
		(error: unknown) => ({ error }),
	);
	return { outcome, calls };
}

describe("a workflow stage on a provider failure nothing recognizes (#4223)", () => {
	test(
		"with a fallback candidate, the stage retries its model before it moves on (#4223)",
		async () => {
			const { outcome, calls } = await stagePrompt({ model: "failing/m", fallbackModels: ["spare/m"] });

			assert.deepEqual(outcome, { text: "ok" });
			assert.deepEqual(calls, { failing: 1 + MAX_RETRIES, spare: 1 });
		},
		REAL_SESSION_TIMEOUT_MS,
	);

	test(
		"with no fallback candidate, the stage fails at once (#4223)",
		async () => {
			const { outcome, calls } = await stagePrompt({ model: "failing/m" });

			assert.ok("error" in outcome, "the stage failed");
			assert.match(String((outcome.error as Error).message), new RegExp(UNRECOGNIZED));
			assert.deepEqual(calls, { failing: 1 });
		},
		REAL_SESSION_TIMEOUT_MS,
	);
});
