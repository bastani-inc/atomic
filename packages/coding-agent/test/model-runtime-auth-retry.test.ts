import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, AssistantMessage, AssistantMessageEvent, Model, Provider } from "@bastani/pi-ai";
import { createAssistantMessageEventStream } from "@bastani/pi-ai/compat";
import { test } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRuntime } from "../src/core/model-runtime.js";

const model: Model<Api> = {
	id: "auth-probe",
	name: "Auth probe",
	provider: "auth-probe",
	api: "openai-completions",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
};

function message(errorMessage?: string): AssistantMessage {
	return {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		content: [],
		stopReason: errorMessage ? "error" : "stop",
		errorMessage,
		timestamp: Date.now(),
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

interface Scenario {
	name: string;
	failure: string;
	rotate?: boolean;
	alwaysReject?: boolean;
	partial?: boolean;
	thrown?: boolean;
	endOnly?: boolean;
	cancel?: boolean;
	prepared?: boolean;
	simple?: boolean;
	traceHeaders?: boolean;
	attempts: number;
	stopReason: AssistantMessage["stopReason"];
}

const scenarios: Scenario[] = [
	{
		name: "retries a 401 with credentials saved elsewhere",
		failure: "401 Unauthorized",
		rotate: true,
		simple: true,
		attempts: 2,
		stopReason: "stop",
	},
	{
		name: "retries an invalid-token stream error",
		failure: "invalid_access_token",
		rotate: true,
		attempts: 2,
		stopReason: "stop",
	},
	{
		name: "retries a revoked-token end-only response",
		failure: "token revoked",
		rotate: true,
		endOnly: true,
		attempts: 2,
		stopReason: "stop",
	},
	{
		name: "retries a provider-invalidated token",
		failure: "Your authentication token has been invalidated. Please sign in again.",
		rotate: true,
		attempts: 2,
		stopReason: "stop",
	},
	{
		name: "retries a thrown HTTP 401",
		failure: "request rejected",
		rotate: true,
		thrown: true,
		attempts: 2,
		stopReason: "stop",
	},
	{
		name: "replaces prepared request auth before retry",
		failure: "401",
		rotate: true,
		prepared: true,
		simple: true,
		attempts: 2,
		stopReason: "stop",
	},
	{
		name: "stops after one credential retry",
		failure: "401",
		rotate: true,
		alwaysReject: true,
		attempts: 2,
		stopReason: "error",
	},
	{ name: "does not retry unchanged credentials", failure: "401", attempts: 1, stopReason: "error" },
	{
		name: "does not retry unchanged credentials when request IDs change",
		failure: "401",
		traceHeaders: true,
		attempts: 1,
		stopReason: "error",
	},
	{
		name: "does not retry ordinary permission failures",
		failure: "403 Forbidden",
		rotate: true,
		attempts: 1,
		stopReason: "error",
	},
	{
		name: "leaves server failures to normal retry policy",
		failure: "520 server error",
		rotate: true,
		attempts: 1,
		stopReason: "error",
	},
	{
		name: "does not replay partially delivered content",
		failure: "401",
		rotate: true,
		partial: true,
		attempts: 1,
		stopReason: "error",
	},
	{
		name: "does not retry an aborted request",
		failure: "401",
		rotate: true,
		cancel: true,
		attempts: 1,
		stopReason: "error",
	},
];

for (const scenario of scenarios) {
	test(`${scenario.name} (#3620)`, async () => {
		const dir = mkdtempSync(join(tmpdir(), "auth-retry-"));
		try {
			const path = join(dir, "auth.json");
			const writer = AuthStorage.create(path);
			await writer.modify(model.provider, async () => ({ type: "api_key", key: "old-fixture" }));
			const runtime = await ModelRuntime.create({ authPath: path, modelsPath: null });
			const controller = new AbortController();
			const keys: (string | undefined)[] = [];
			const stream: Provider["stream"] = (_model, _context, options) => {
				const output = createAssistantMessageEventStream();
				keys.push(options?.apiKey);
				if (keys.length === 1 && scenario.rotate) {
					writeFileSync(path, JSON.stringify({ [model.provider]: { type: "api_key", key: "new-fixture" } }));
				}
				if (scenario.cancel) controller.abort();
				if (scenario.thrown && keys.length === 1) throw Object.assign(new Error(scenario.failure), { status: 401 });
				const failed = keys.length === 1 || scenario.alwaysReject;
				const result = message(failed ? scenario.failure : undefined);
				if (scenario.endOnly) output.end(result);
				else {
					output.push({ type: "start", partial: message() });
					if (scenario.partial)
						output.push({ type: "text_delta", contentIndex: 0, delta: "partial", partial: message() });
					if (failed) output.push({ type: "error", reason: "error", error: result });
					else output.push({ type: "done", reason: "stop", message: result });
				}
				return output;
			};
			runtime.registerNativeProvider({
				id: model.provider,
				name: "Auth probe",
				auth: {
					apiKey: {
						name: "Auth probe key",
						resolve: async ({ credential }) =>
							credential?.key ? { auth: { apiKey: credential.key }, source: "stored" } : undefined,
					},
				},
				models: [model],
				stream,
				streamSimple: stream,
			});
			let requestId = 0;
			const options = {
				signal: controller.signal,
				...(scenario.traceHeaders ? { transformHeaders: () => ({ "X-Request-Id": String(++requestId) }) } : {}),
				...(scenario.prepared ? { preparedRequestAuth: { resolution: await runtime.getAuth(model) } } : {}),
			};
			const response = scenario.simple
				? runtime.streamSimple(model, { messages: [] }, options)
				: runtime.stream(model, { messages: [] }, options);
			const events: AssistantMessageEvent[] = [];
			for await (const event of response) events.push(event);
			const result = await response.result();
			assert.equal(result.stopReason, scenario.stopReason, result.errorMessage);
			assert.equal(keys.length, scenario.attempts);
			assert.deepEqual(keys, scenario.attempts === 2 ? ["old-fixture", "new-fixture"] : ["old-fixture"]);
			assert.ok(events.filter((event) => event.type === "start").length <= 1);
			assert.equal(events.filter((event) => event.type === "done" || event.type === "error").length, 1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
}

for (const credentialOverride of ["explicit header", "transformed header", "explicit api key", "rotating header"]) {
	test(`compares effective credentials after ${credentialOverride} precedence (#3620)`, async () => {
		const dir = mkdtempSync(join(tmpdir(), "auth-retry-precedence-"));
		try {
			const path = join(dir, "auth.json");
			const writer = AuthStorage.create(path);
			await writer.modify(model.provider, async () => ({ type: "api_key", key: "old-fixture" }));
			const runtime = await ModelRuntime.create({ authPath: path, modelsPath: null });
			const attempts: (string | undefined)[] = [];
			const headerAuth = credentialOverride !== "explicit api key";
			const stream: Provider["stream"] = (_model, _context, options) => {
				attempts.push(headerAuth ? options?.headers?.Authorization : options?.apiKey);
				writeFileSync(path, JSON.stringify({ [model.provider]: { type: "api_key", key: "new-fixture" } }));
				const output = createAssistantMessageEventStream();
				output.push({ type: "error", reason: "error", error: message("401 Unauthorized") });
				return output;
			};
			runtime.registerNativeProvider({
				id: model.provider,
				name: "Auth probe",
				auth: {
					apiKey: {
						name: "Auth probe key",
						resolve: async ({ credential }) =>
							credential?.key
								? {
										auth: headerAuth
											? { headers: { Authorization: `Bearer ${credential.key}` } }
											: { apiKey: credential.key },
										source: "stored",
									}
								: undefined,
					},
				},
				models: [model],
				stream,
				streamSimple: stream,
			});
			const response = runtime.streamSimple(
				model,
				{ messages: [] },
				{
					...(credentialOverride === "explicit header" ? { headers: { Authorization: "fixed-fixture" } } : {}),
					...(credentialOverride === "transformed header"
						? { transformHeaders: () => ({ Authorization: "fixed-fixture" }) }
						: {}),
					...(credentialOverride === "explicit api key" ? { apiKey: "fixed-fixture" } : {}),
				},
			);
			assert.equal((await response.result()).stopReason, "error");
			assert.deepEqual(
				attempts,
				credentialOverride === "rotating header" ? ["Bearer old-fixture", "Bearer new-fixture"] : ["fixed-fixture"],
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
}
