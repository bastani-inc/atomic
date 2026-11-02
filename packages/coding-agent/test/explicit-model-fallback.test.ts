/**
 * A main session started on an explicit `--model` runs only that model and the models named with `--fallback-models`
 * (#4223). Real CLI option building, real AgentSession retry and fallback machinery, and fake providers that fail the
 * way real ones do; no network is contacted.
 */

import assert from "node:assert/strict";
import { getCurrentSystemPrompt } from "@bastani/pi-ai";
import { type AssistantMessage, createAssistantMessageEventStream, getModel, type Model } from "@bastani/pi-ai/compat";
import { afterEach, describe, test } from "vitest";
import { parseArgs } from "../src/cli/args.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { buildSessionOptions } from "../src/main-session-options.ts";
import { createTestResourceLoader } from "./utilities.ts";

const REQUESTED = { provider: "acct-a", id: "argon-mock", name: "Argon Mock" };
const SETTINGS_CHAIN = { provider: "acct-b", id: "opus-mock", name: "Opus Mock" };
const OPT_IN = { provider: "acct-c", id: "sol-mock", name: "Sol Mock" };
const MAX_RETRIES = 2;

/** Error texts real providers produced; see #4223 for the cases they come from. */
const TRANSIENT_FAILURES = {
	"a 5xx": '500: {"message":"Internal server error","type":"server_error"}',
	"a stream reset": "terminated",
	"a stalled stream": "Request timed out.",
	"a stream that ends early": "Stream ended without finish_reason",
	"an unrecognized error with no status or code": "the provider said something nobody has seen before",
} as const;
const CONTENT_FILTER_422 =
	'github-copilot API error (422): {"message":"This content was flagged for possible cybersecurity risk. If this seems wrong, try rephrasing your request.","code":"cyber_policy"}';
/** The same refusal delivered as an error event inside the response stream. */
const CONTENT_FILTER_IN_STREAM =
	'reading rate-limited responses stream: reading program fingerprint response stream: reading usage tracking responses stream: reading encrypted response stream: reading from source stream: reading responses stream: reading SSE event: {"error":{"message":"This content was flagged for possible cybersecurity risk. If this seems wrong, try rephrasing your request.","code":"cyber_policy"}}';

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

interface Request {
	model: string;
	systemPrompt: string;
}

/** Three accounts. The requested model fails with `failure` every time; the others answer. */
async function runSession(args: string[], failure: string, settings: { defaultToRequested?: boolean } = {}) {
	const base = getModel("anthropic", "claude-sonnet-4-5")!;
	const runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	const requests: Request[] = [];
	for (const account of [REQUESTED, SETTINGS_CHAIN, OPT_IN]) {
		const model: Model<"anthropic-messages"> = { ...base, ...account, reasoning: true };
		runtime.registerProvider(account.provider, {
			api: base.api,
			baseUrl: base.baseUrl,
			apiKey: "fixture-key",
			models: [model],
			streamSimple: (requestModel, context) => {
				requests.push({
					model: `${requestModel.provider}/${requestModel.id}`,
					// What the model is told: every system message replayed into the current prompt.
					systemPrompt: getCurrentSystemPrompt(context.messages),
				});
				const failed = account === REQUESTED;
				const message: AssistantMessage = {
					role: "assistant",
					content: failed ? [] : [{ type: "text", text: `answered by ${account.id}` }],
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
	// The user-level chain names another family, as in the reports.
	const settingsManager = SettingsManager.inMemory({
		...(settings.defaultToRequested ? { defaultProvider: REQUESTED.provider, defaultModel: REQUESTED.id } : {}),
		fallbackModels: [`${SETTINGS_CHAIN.provider}/${SETTINGS_CHAIN.id}`],
		retry: { enabled: true, maxRetries: MAX_RETRIES, baseDelayMs: 1, maxAgentDelayMs: 1 },
	});
	const { options, diagnostics } = buildSessionOptions(parseArgs(args), [], false, runtime, settingsManager);
	assert.deepEqual(diagnostics, []);
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
	await session.prompt("Say which model you are.");
	const last = session.state.messages.findLast((message) => message.role === "assistant") as AssistantMessage;
	return { requests, last, sessionManager };
}

const requestedId = `${REQUESTED.provider}/${REQUESTED.id}`;

describe("an explicit --model session keeps to its own model (#4223)", () => {
	for (const [kind, failure] of Object.entries(TRANSIENT_FAILURES)) {
		test(`${kind} is retried on the requested model and never moves to the settings fallbackModels (#4223)`, async () => {
			const { requests, last } = await runSession(["--model", `${requestedId}:high`], failure);

			assert.deepEqual(
				requests.map((request) => request.model),
				Array(1 + MAX_RETRIES).fill(requestedId),
			);
			assert.equal(last.stopReason, "error");
			assert.equal(`${last.provider}/${last.model}`, requestedId);
		});
	}

	for (const [kind, refusal] of [
		["an HTTP 422", CONTENT_FILTER_422],
		["an error event inside the stream", CONTENT_FILTER_IN_STREAM],
	] as const) {
		test(`a content-filter refusal as ${kind} fails on the requested model at once, with no retry and no other model (#4223)`, async () => {
			const { requests, last } = await runSession(["--model", `${requestedId}:high`], refusal);

			assert.deepEqual(
				requests.map((request) => request.model),
				[requestedId],
			);
			assert.equal(last.stopReason, "error");
			assert.match(last.errorMessage ?? "", /cyber_policy/);
		});
	}

	test("--fallback-models opts in: the refusal moves to that model, which is told its own name, and the session records why (#4223)", async () => {
		const optIn = `${OPT_IN.provider}/${OPT_IN.id}`;
		const { requests, last, sessionManager } = await runSession(
			["--model", `${requestedId}:high`, "--fallback-models", optIn],
			CONTENT_FILTER_422,
		);

		assert.deepEqual(
			requests.map((request) => request.model),
			[requestedId, optIn],
		);
		assert.match(requests[1]!.systemPrompt, /Model name \(used for commit attribution\): Sol Mock/);
		assert.doesNotMatch(requests[1]!.systemPrompt, /Argon Mock/);
		assert.equal(last.stopReason, "stop");
		const fallbackChange = sessionManager
			.getEntries()
			.findLast((entry) => entry.type === "model_change" && entry.provider === OPT_IN.provider);
		assert.ok(fallbackChange && fallbackChange.type === "model_change");
		assert.equal(fallbackChange.fallback?.requested, requestedId);
		assert.equal(fallbackChange.fallback?.from, requestedId);
		assert.match(fallbackChange.fallback?.reason ?? "", /cyber_policy/);
	});

	test("--no-fallback turns the settings fallbackModels off for a session without --model (#4223)", async () => {
		const settingsChain = `${SETTINGS_CHAIN.provider}/${SETTINGS_CHAIN.id}`;
		const withChain = await runSession([], TRANSIENT_FAILURES["a 5xx"], { defaultToRequested: true });
		assert.equal(withChain.requests.at(-1)?.model, settingsChain);

		const { requests } = await runSession(["--no-fallback"], TRANSIENT_FAILURES["a 5xx"], {
			defaultToRequested: true,
		});
		assert.deepEqual(
			requests.map((request) => request.model),
			Array(1 + MAX_RETRIES).fill(requestedId),
		);
	});
});
