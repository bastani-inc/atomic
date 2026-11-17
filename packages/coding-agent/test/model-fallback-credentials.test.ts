import assert from "node:assert/strict";
import { GitHubCopilotAuthenticationError } from "@bastani/atomic-ai";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	getModel,
	type Model,
} from "@bastani/atomic-ai/compat";
import { afterEach, describe, test } from "vitest";
import { parseArgs } from "../src/cli/args.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { isProviderCredentialRejection, normalizeModelFailureSignal } from "../src/core/model-fallback-failures.js";
import { ModelRuntime } from "../src/core/model-runtime.js";
import { createAgentSession } from "../src/core/sdk.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { buildSessionOptions } from "../src/main-session-options.js";
import { createTestResourceLoader } from "./utilities.js";

const NO_KEY = { provider: "nokey-acct", ids: ["nokey-a", "nokey-b"], key: undefined };
const REVOKED = { provider: "revoked-acct", ids: ["revoked-a", "revoked-b"], key: "revoked-key" };
const WORKING = { provider: "working-acct", ids: ["working-a", "working-b"], key: "working-key" };
const ACCOUNTS = [NO_KEY, REVOKED, WORKING];
const REVOKED_401 =
	'401 {"error":{"message":"Incorrect API key provided","type":"invalid_request_error","code":"invalid_api_key"}}';

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function usage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

const id = (account: (typeof ACCOUNTS)[number], index = 0) => `${account.provider}/${account.ids[index]}`;

async function runSession(
	args: string[],
	settings: Record<string, unknown> = {},
	failures?: ReadonlyMap<string, string>,
) {
	const base = getModel("anthropic", "claude-sonnet-4-5")!;
	const runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	const requests: string[] = [];
	for (const account of ACCOUNTS) {
		const models: Model<"anthropic-messages">[] = account.ids.map((modelId) => ({
			...base,
			provider: account.provider,
			id: modelId,
			name: modelId,
			reasoning: false,
		}));
		runtime.registerProvider(account.provider, {
			api: base.api,
			baseUrl: base.baseUrl,
			...(account.key === undefined ? {} : { apiKey: account.key }),
			models,
			streamSimple: (requestModel) => {
				requests.push(`${requestModel.provider}/${requestModel.id}`);
				const failure = failures
					? failures.get(`${requestModel.provider}/${requestModel.id}`)
					: account === REVOKED
						? REVOKED_401
						: undefined;
				const failed = failure !== undefined;
				const message: AssistantMessage = {
					role: "assistant",
					content: failed ? [] : [{ type: "text", text: `answered by ${requestModel.id}` }],
					api: base.api,
					provider: account.provider,
					model: requestModel.id,
					usage: usage(),
					stopReason: failed ? "error" : "stop",
					...(failed ? { errorMessage: failure } : {}),
					timestamp: Date.now(),
				};
				const stream = createAssistantMessageEventStream();
				if (failed) stream.push({ type: "error", reason: "error", error: message });
				else stream.push({ type: "done", reason: "stop", message });
				stream.end(message);
				return stream;
			},
		});
		cleanups.push(() => runtime.unregisterProvider(account.provider));
	}
	const settingsManager = SettingsManager.inMemory({
		defaultProvider: WORKING.provider,
		defaultModel: WORKING.ids[1],
		retry: { enabled: true, maxRetries: 2, baseDelayMs: 1, maxAgentDelayMs: 1 },
		...settings,
	});
	const { options } = buildSessionOptions(parseArgs(args), [], false, runtime, settingsManager);
	const sessionManager = SessionManager.inMemory();
	const { session } = await createAgentSession({
		...options,
		cwd: process.cwd(),
		modelRuntime: runtime,
		settingsManager,
		sessionManager,
		resourceLoader: createTestResourceLoader(),
		builtins: { workflows: false, subagents: false, intercom: false, mcp: false, "web-access": false },
		tools: ["read"],
	});
	cleanups.push(() => session.dispose());
	const eventTypes: string[] = [];
	session.subscribe((event) => eventTypes.push(event.type));
	const outcome = await session.prompt("Say which model you are.").then(
		() => undefined,
		(error: unknown) => error,
	);
	const last = session.state.messages.findLast((message) => message.role === "assistant") as
		| AssistantMessage
		| undefined;
	return { requests, last, sessionManager, outcome, eventTypes, session };
}

describe("a model chain skips models whose provider has no credentials", () => {
	test("a chain whose first model has no credentials starts on its first model that has them, without asking the skipped provider", async () => {
		const { requests, last, sessionManager, eventTypes, outcome } = await runSession([
			"--model",
			id(NO_KEY),
			"--fallback-models",
			`${id(NO_KEY, 1)},${id(WORKING)}`,
		]);

		assert.equal(outcome, undefined);
		assert.deepEqual(requests, [id(WORKING)]);
		assert.equal(last?.stopReason, "stop");
		assert.ok(!eventTypes.includes("auto_retry_start"));
		const change = sessionManager
			.getEntries()
			.findLast((entry) => entry.type === "model_change" && entry.provider === WORKING.provider);
		assert.ok(change && change.type === "model_change");
		assert.equal(change.fallback?.requested, id(NO_KEY));
		assert.deepEqual(change.fallback?.skipped, [
			{ model: id(NO_KEY), provider: NO_KEY.provider, reason: "no-credentials" },
			{ model: id(NO_KEY, 1), provider: NO_KEY.provider, reason: "no-credentials" },
		]);
		assert.doesNotMatch(JSON.stringify(sessionManager.getEntries()), /working-key|revoked-key/);
	});

	test("a chain with no model that has credentials fails at once, naming each model and the provider it lacks", async () => {
		const { requests, outcome, eventTypes } = await runSession([
			"--model",
			id(NO_KEY),
			"--fallback-models",
			id(NO_KEY, 1),
		]);

		assert.deepEqual(requests, []);
		assert.ok(outcome instanceof Error);
		assert.equal(outcome.name, "NoUsableModelError");
		assert.match(outcome.message, /nokey-acct\/nokey-a .*nokey-acct/);
		assert.match(outcome.message, /nokey-acct\/nokey-b/);
		assert.match(outcome.message, /No API key found/);
		assert.ok(!eventTypes.includes("auto_retry_start"));
	});

	test("a single pinned model without credentials fails naming it, and no other model runs in its place", async () => {
		const { requests, outcome } = await runSession(["--model", id(NO_KEY)], {
			fallbackModels: [id(WORKING)],
		});

		assert.deepEqual(requests, []);
		assert.ok(outcome instanceof Error);
		assert.equal(outcome.name, "NoUsableModelError");
		assert.match(outcome.message, /nokey-acct\/nokey-a/);
		assert.match(outcome.message, /No API key found for nokey-acct/);
	});
});

describe("an auth failure takes its provider out of the chain", () => {
	test("typed authentication failures distinguish permission denials from rejected credentials", () => {
		for (const [context, expected] of [
			[{ status: 403, detail: "Project does not have access to model a" }, false],
			[{ status: 403, providerCode: "invalid_api_key" }, true],
			[{ status: 403, detail: "Incorrect API key provided" }, true],
		] as const) {
			const failure = new GitHubCopilotAuthenticationError({
				modelId: "model-a",
				api: "openai-completions",
				...context,
			});
			assert.equal(isProviderCredentialRejection(failure), expected, JSON.stringify(context));
		}
	});

	test("generic authentication codes on a 403 do not prove a provider credential rejection", () => {
		for (const code of ["authentication-failed", "unauthorized", "auth_required", "authentication_required"]) {
			assert.equal(isProviderCredentialRejection({ status: 403, code, message: "localized" }), false, code);
		}
	});

	for (const errorMessage of ["oauth_token_invalidated", "refresh_token_expired"]) {
		test(`a raw token rejection blocks its provider: ${errorMessage}`, async () => {
			const { requests } = await runSession(
				["--model", id(REVOKED), "--fallback-models", `${id(REVOKED, 1)},${id(WORKING)}`],
				{},
				new Map([[id(REVOKED), errorMessage]]),
			);

			assert.deepEqual(requests, [id(REVOKED), id(WORKING)]);
		});
	}

	test("401 credential rejections survive generic request codes and status-only messages", () => {
		for (const failure of [
			{ status: 401, code: "invalid_request_error", message: "localized" },
			"HTTP 401: Unauthorized",
			'{"error":{"code":401,"message":"localized"}}',
		]) {
			assert.equal(isProviderCredentialRejection(failure), true, JSON.stringify(failure));
		}
	});
	for (const errorMessage of [
		'403 {"error":{"message":"Project does not have access to model revoked-a","code":"model_not_found"}}',
		'403 {"error":{"message":"Input was flagged by moderation","code":403}}',
		'403 {"error":{"message":"Invalid token count for model revoked-a"}}',
	]) {
		test(`a model-scoped rejection keeps other models on its provider available: ${errorMessage}`, async () => {
			const { requests, last } = await runSession(
				["--model", id(REVOKED), "--fallback-models", `${id(REVOKED, 1)},${id(WORKING)}`],
				{},
				new Map([[id(REVOKED), errorMessage]]),
			);

			assert.deepEqual(requests, [id(REVOKED), id(REVOKED, 1)]);
			assert.equal(last?.model, REVOKED.ids[1]);
			assert.equal(last?.stopReason, "stop");
		});
	}

	test("a rejected API key filed under OpenAI's invalid_request_error is an auth failure, not an incompatible request", () => {
		for (const errorMessage of [
			REVOKED_401,
			'401: {"message":"Incorrect API key provided","type":"invalid_request_error","code":"invalid_api_key"}',
			'400 {"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT"}}',
		]) {
			assert.equal(
				normalizeModelFailureSignal({ role: "assistant", stopReason: "error", errorMessage }).kind,
				"auth_on_candidate_provider",
				errorMessage,
			);
		}
		assert.equal(
			normalizeModelFailureSignal({
				role: "assistant",
				stopReason: "error",
				errorMessage: '400 {"error":{"message":"Unsupported parameter: tools","type":"invalid_request_error"}}',
			}).kind,
			"request_incompatible",
		);
	});
	test("a 401 moves to the next provider at once and never asks the refusing provider again", async () => {
		const { requests, last, sessionManager } = await runSession([
			"--model",
			id(REVOKED),
			"--fallback-models",
			`${id(REVOKED, 1)},${id(WORKING)}`,
		]);

		assert.deepEqual(requests, [id(REVOKED), id(WORKING)]);
		assert.equal(last?.stopReason, "stop");
		const change = sessionManager
			.getEntries()
			.findLast((entry) => entry.type === "model_change" && entry.provider === WORKING.provider);
		assert.ok(change && change.type === "model_change");
		assert.deepEqual(change.fallback?.skipped, [
			{ model: id(REVOKED, 1), provider: REVOKED.provider, reason: "auth-failed" },
		]);
	});
});
