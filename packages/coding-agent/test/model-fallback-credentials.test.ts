import assert from "node:assert/strict";
import { GitHubCopilotAuthenticationError, recordGitHubCopilotError } from "@bastani/atomic-ai";
import { type AssistantMessage, createAssistantMessageEventStream, type Model } from "@bastani/atomic-ai/compat";
import { afterEach, describe, test } from "vitest";
import { getFixtureModel } from "../../../test/helpers/catalog-model-fixtures.ts";
import { parseArgs } from "../src/cli/args.js";
import type { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import type { VerbatimCompactionDetails } from "../src/core/compaction/compaction-types.js";
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
	failures?: ReadonlyMap<string, string | GitHubCopilotAuthenticationError>,
	beforePrompt?: (session: AgentSession) => void,
) {
	const base = getFixtureModel("anthropic", "claude-sonnet-4-5")!;
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
					...(typeof failure === "string" ? { errorMessage: failure } : {}),
					timestamp: Date.now(),
				};
				if (failure instanceof GitHubCopilotAuthenticationError) recordGitHubCopilotError(message, failure);
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
		builtins: { subagents: false, intercom: false, mcp: false, "web-access": false },
		tools: ["read"],
	});
	cleanups.push(() => session.dispose());
	const eventTypes: string[] = [];
	session.subscribe((event) => eventTypes.push(event.type));
	beforePrompt?.(session);
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

	test("interrupting the switch away from a model with no credentials sends no request (#5564)", async () => {
		const { requests, eventTypes, session } = await runSession(
			["--model", id(NO_KEY), "--fallback-models", id(WORKING)],
			{},
			undefined,
			(starting) => {
				starting.subscribe((event) => {
					if (event.type === "model_fallback_start") void starting.interruptTurn();
				});
			},
		);
		assert.ok(eventTypes.includes("model_fallback_start"));
		assert.deepEqual(requests, []);
		await session.prompt("new turn");
		assert.deepEqual(requests, [id(WORKING)]);
	});

	test("a retry interrupt arriving during fallback request preparation still stops dispatch (#5564)", async () => {
		const { requests } = await runSession(
			["--model", id(REVOKED), "--fallback-models", id(WORKING)],
			{},
			undefined,
			(starting) => {
				starting.subscribe((event) => {
					if (event.type === "agent_start" && starting.model?.provider === WORKING.provider) starting.abortRetry();
				});
			},
		);
		assert.deepEqual(requests, [id(REVOKED)]);
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

	test("a streamed permission denial without a status keeps other models on its provider eligible (#3326)", async () => {
		const failure = new GitHubCopilotAuthenticationError({
			modelId: REVOKED.ids[0],
			api: "anthropic-messages",
			providerCode: "permission_error",
			detail: "localized",
		});
		const { requests, last } = await runSession(
			["--model", id(REVOKED), "--fallback-models", `${id(REVOKED, 1)},${id(WORKING)}`],
			{},
			new Map([[id(REVOKED), failure]]),
		);
		assert.deepEqual(requests, [id(REVOKED), id(REVOKED, 1)]);
		assert.equal(last?.stopReason, "stop");
	});

	test("a streamed authentication rejection without a status excludes its provider (#3326)", async () => {
		const failure = new GitHubCopilotAuthenticationError({
			modelId: REVOKED.ids[0],
			api: "anthropic-messages",
			providerCode: "authentication_error",
			detail: "localized",
		});
		assert.equal(isProviderCredentialRejection(failure), true);
		const { requests } = await runSession(
			["--model", id(REVOKED), "--fallback-models", `${id(REVOKED, 1)},${id(WORKING)}`],
			{},
			new Map([[id(REVOKED), failure]]),
		);
		assert.deepEqual(requests, [id(REVOKED), id(WORKING)]);
	});

	test("expired, leaked, and disabled API key codes block their provider even when the message is localized (#3326)", () => {
		for (const code of ["API_KEY_INVALID", "API_KEY_EXPIRED", "API_KEY_DISABLED", "API_KEY_LEAKED"]) {
			assert.equal(isProviderCredentialRejection({ status: 400, code, message: "localized" }), true, code);
		}
	});

	test("credential rejection codes and exception names block their provider without relying on English messages (#3326)", () => {
		for (const code of [
			"expired_token_exception",
			"ExpiredTokenException",
			"unrecognized_client_exception",
			"UnrecognizedClientException",
			"consumer_suspended",
			"api_key_service_blocked",
			"InvalidSignatureException",
			"invalid_signature_exception",
			"API_KEY_HTTP_REFERRER_BLOCKED",
			"API_KEY_IP_ADDRESS_BLOCKED",
			"API_KEY_ANDROID_APP_BLOCKED",
			"API_KEY_IOS_APP_BLOCKED",
		]) {
			for (const failure of [
				{ status: 403, code, message: "localized" },
				Object.assign(new Error("localized"), { name: code, status: 403 }),
				{ code, message: "localized" },
			]) {
				assert.equal(isProviderCredentialRejection(failure), true, JSON.stringify(failure));
			}
		}
	});

	test("generic authentication codes on a 403 do not prove a provider credential rejection", () => {
		for (const code of ["authentication-failed", "unauthorized", "auth_required", "authentication_required"]) {
			assert.equal(isProviderCredentialRejection({ status: 403, code, message: "localized" }), false, code);
		}
	});

	for (const errorMessage of [
		"oauth_token_invalidated",
		"refresh_token_expired",
		"invalidapikey",
		'400 {"error":{"code":400,"message":"API key expired. Please renew the API key.","details":[{"reason":"API_KEY_INVALID"}]}}',
		'403 {"error":{"code":403,"message":"Your API key was reported as leaked"}}',
		"403 Your API key has been disabled",
		"403 Your access token has expired",
		"400 ExpiredTokenException: The security token included in the request is expired",
		"400 ExpiredTokenException: The security token included in the request has expired",
		"403 UnrecognizedClientException: The security token included in the request is invalid",
		"403 The security token included in the request is invalid",
		"400 The security token included in the request has expired",
		'403 {"error":{"code":403,"details":[{"reason":"CONSUMER_SUSPENDED"}]}}',
		'{"error":{"details":[{"reason":"CONSUMER_SUSPENDED"}]}}',
		'403 {"error":{"code":403,"details":[{"reason":"API_KEY_SERVICE_BLOCKED"}]}}',
		"403 InvalidSignatureException: The request signature we calculated does not match the signature you provided.",
		'403 {"error":{"code":403,"details":[{"reason":"API_KEY_HTTP_REFERRER_BLOCKED"}]}}',
		'403 {"error":{"code":403,"details":[{"reason":"API_KEY_IP_ADDRESS_BLOCKED"}]}}',
		'403 {"error":{"code":403,"details":[{"reason":"API_KEY_ANDROID_APP_BLOCKED"}]}}',
		'403 {"error":{"code":403,"details":[{"reason":"API_KEY_IOS_APP_BLOCKED"}]}}',
	]) {
		test(`a raw credential rejection blocks its provider (#3326): ${errorMessage}`, async () => {
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

	test("compaction on overflow after a 401 fallback clears the context and sends nothing to the rejected provider (#3326)", async () => {
		const base = getFixtureModel("anthropic", "claude-sonnet-4-5")!;
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		const requests: string[] = [];
		let workingACalls = 0;
		for (const account of [REVOKED, WORKING]) {
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
				apiKey: account.key,
				models,
				streamSimple: (requestModel) => {
					const fullId = `${requestModel.provider}/${requestModel.id}`;
					requests.push(fullId);
					const call = fullId === id(WORKING) ? ++workingACalls : 0;
					const failure =
						account === REVOKED
							? REVOKED_401
							: fullId === id(WORKING) && call === 1
								? "prompt is too long"
								: undefined;
					const failed = failure !== undefined;
					const text = fullId === id(WORKING, 1) ? "1:1,3\n" : `answered by ${requestModel.id}`;
					const message: AssistantMessage = {
						role: "assistant",
						content: failed ? [] : [{ type: "text", text }],
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
		});
		const { options } = buildSessionOptions(
			parseArgs(["--model", id(REVOKED), "--fallback-models", `${id(WORKING)},${id(REVOKED, 1)},${id(WORKING, 1)}`]),
			[],
			false,
			runtime,
			settingsManager,
		);
		const sessionManager = SessionManager.inMemory();
		const { session } = await createAgentSession({
			...options,
			cwd: process.cwd(),
			modelRuntime: runtime,
			settingsManager,
			sessionManager,
			resourceLoader: createTestResourceLoader(),
			builtins: { subagents: false, intercom: false, mcp: false, "web-access": false },
			tools: ["read"],
		});
		cleanups.push(() => session.dispose());

		await session.prompt(Array.from({ length: 20 }, (_, index) => `context line ${index}`).join("\n"));

		// Compaction makes no model request, so nothing can reach the provider that rejected its key.
		assert.deepEqual(requests, [id(REVOKED), id(WORKING), id(WORKING)]);
		const compaction = sessionManager.getEntries().find((entry) => entry.type === "compaction");
		assert.ok(compaction && compaction.type === "compaction");
		assert.equal((compaction.details as VerbatimCompactionDetails | undefined)?.form, "cleared");
	});
});
