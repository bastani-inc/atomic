import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { describe, it } from "vitest";
import { COPILOT_API_VERSION, copilotClientHeaders } from "../src/api/github-copilot-headers.ts";
import { getModels, streamSimple } from "../src/compat.ts";
import { parseGitHubCopilotDiscoveredModels } from "../src/providers/github-copilot.ts";
import { describeGitHubCopilotModel } from "../src/providers/github-copilot-capabilities.ts";
import { resolveCopilotEnvBaseUrl } from "../src/providers/github-copilot-env.ts";
import {
	GitHubCopilotModelUnavailableError,
	type GitHubCopilotModelUnavailableReason,
	getGitHubCopilotError,
} from "../src/providers/github-copilot-errors.ts";
import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions, Tool, ToolCall } from "../src/types.ts";
import { retryAssistantCall } from "../src/utils/retry.ts";
import { resolveApiKey } from "./oauth.ts";

/**
 * Live smoke test of every non-OpenAI, non-Anthropic model family in GitHub Copilot's built-in catalog, plus the
 * account's own models of other vendors. It makes real, small Copilot calls and skips without a Copilot token; run
 * it with ATOMIC_TEST_KEEP_PROVIDER_CREDENTIALS=1 and either a saved login or COPILOT_GITHUB_TOKEN. A catalog model
 * the account does not list is still called: Copilot must reject it as `model-unavailable`, and it is reported as not
 * entitled with that rejection (or exercised in full if it answers). Set COPILOT_SMOKE_REPORT to a path to
 * write the per-model results as JSON.
 */

const token = (await resolveApiKey("github-copilot")) ?? process.env.COPILOT_GITHUB_TOKEN?.trim();
const baseUrl = token ? resolveCopilotEnvBaseUrl({ ...process.env, COPILOT_GITHUB_TOKEN: token }) : undefined;
const LIVE_COPILOT_FAMILY_TIMEOUT_MS = 240_000;
const FAMILY_PREFIXES = ["gemini-", "kimi-", "grok-", "mai-"] as const;
const OTHER_VENDORS = new Set(["OpenAI", "Anthropic", "Azure OpenAI"]);
const UNAVAILABLE_REASONS: readonly GitHubCopilotModelUnavailableReason[] = [
	"integration",
	"not-supported",
	"wrong-api",
	"no-endpoint",
	"not-found",
];

const tools: Tool[] = [
	{
		name: "get_weather",
		description: "Current weather for a city",
		parameters: {
			type: "object",
			properties: { city: { type: "string" } },
			required: ["city"],
		} as Tool["parameters"],
	},
	{
		name: "ping",
		description: "Checks connectivity. Takes no arguments.",
		parameters: { type: "object", properties: {} } as Tool["parameters"],
	},
];

const redCircle = readFileSync(new URL("./data/red-circle.png", import.meta.url)).toString("base64");

interface AccountEntry {
	readonly id: string;
	readonly vendor: string | undefined;
	readonly endpoints: readonly string[];
}

async function readAccountModels(): Promise<{ entries: AccountEntry[]; raw: unknown }> {
	const response = await fetch(`${baseUrl}/models`, {
		headers: {
			Accept: "application/json",
			Authorization: `Bearer ${token}`,
			...copilotClientHeaders(token ?? ""),
			"X-GitHub-Api-Version": COPILOT_API_VERSION,
		},
	});
	assert.equal(response.status, 200, "the account's model list must be readable");
	const raw = (await response.json()) as { data: Array<Record<string, unknown>> };
	const entries = raw.data.map((entry) => ({
		id: String(entry.id),
		vendor: typeof entry.vendor === "string" ? entry.vendor : undefined,
		endpoints: Array.isArray(entry.supported_endpoints) ? entry.supported_endpoints.map(String) : [],
	}));
	return { entries, raw };
}

const RETRY = { enabled: true, maxRetries: 2, baseDelayMs: 1000 };

async function call(model: Model<Api>, context: Context, options?: SimpleStreamOptions): Promise<AssistantMessage> {
	return retryAssistantCall(
		() =>
			streamSimple(model, context, {
				apiKey: token,
				maxTokens: 2048,
				reasoning: model.reasoning ? "low" : undefined,
				maxRetries: 1,
				...options,
			}).result(),
		RETRY,
		undefined,
	);
}

function text(message: AssistantMessage): string {
	return message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

function calls(message: AssistantMessage): ToolCall[] {
	return message.content.filter((block): block is ToolCall => block.type === "toolCall");
}

interface SmokeResult {
	model: string;
	family: string;
	api?: string;
	status: "passed" | "not entitled";
	checks: Record<string, string>;
}

const results: SmokeResult[] = [];

function report(): void {
	const path = process.env.COPILOT_SMOKE_REPORT;
	if (path) writeFileSync(path, `${JSON.stringify(results, null, 2)}\n`);
}

async function smoke(model: Model<Api>, family: string): Promise<SmokeResult> {
	const routed: Model<Api> = { ...model, baseUrl: baseUrl ?? model.baseUrl };
	const result: SmokeResult = { model: model.id, family, api: model.api, status: "passed", checks: {} };
	const capabilities = describeGitHubCopilotModel(routed);
	assert.ok(capabilities, `${model.id} must have a capability record`);

	const hello = await call(routed, {
		messages: [{ role: "user", content: "Reply with the single word: ready", timestamp: Date.now() }],
	});
	assert.equal(hello.stopReason, "stop", `${model.id} text: ${hello.errorMessage}`);
	assert.match(text(hello), /ready/i);
	assert.ok(hello.usage.output > 0 && hello.usage.input > 0, `${model.id} usage ${JSON.stringify(hello.usage)}`);
	assert.equal(
		hello.usage.totalTokens,
		hello.usage.input + hello.usage.output + hello.usage.cacheRead + hello.usage.cacheWrite,
	);
	result.checks.text = `stop; usage in=${hello.usage.input} out=${hello.usage.output} reasoning=${hello.usage.reasoning}`;

	const toolContext: Context = {
		systemPrompt: "You are a tool-calling test harness. Call tools exactly as asked, in parallel when asked.",
		messages: [
			{
				role: "user",
				content:
					"In one turn, call get_weather with city Paris and also call ping. Do not answer before the calls.",
				timestamp: Date.now(),
			},
		],
		tools,
	};
	const first = await call(routed, toolContext);
	assert.equal(first.stopReason, "toolUse", `${model.id} tool turn: ${first.errorMessage}`);
	const toolCalls = calls(first);
	const weather = toolCalls.find((toolCall) => toolCall.name === "get_weather");
	assert.ok(weather, `${model.id} must call get_weather`);
	assert.match(String(weather.arguments.city), /paris/i);
	const ping = toolCalls.find((toolCall) => toolCall.name === "ping");
	if (ping) assert.deepEqual(ping.arguments, {});
	const opaque = first.content.some((block) => block.type === "thinking" && block.redacted === true);
	const reasoningBlocks = first.content.filter((block) => block.type === "thinking").length;
	result.checks.toolCalls = `${toolCalls.length} call(s): ${toolCalls.map((toolCall) => toolCall.name).join(", ")}; ids ${toolCalls.map((toolCall) => toolCall.id.length).join("/")} chars`;
	result.checks.reasoningCaptured = `${reasoningBlocks} block(s)${opaque ? ", opaque" : ""}`;

	const second = await call(routed, {
		...toolContext,
		messages: [
			...toolContext.messages,
			first,
			...toolCalls.map((toolCall) => ({
				role: "toolResult" as const,
				toolCallId: toolCall.id,
				toolName: toolCall.name,
				content: [{ type: "text" as const, text: toolCall.name === "ping" ? "pong" : "Sunny, 21C" }],
				isError: false,
				timestamp: Date.now(),
			})),
		],
	});
	assert.equal(second.stopReason, "stop", `${model.id} tool loop: ${second.errorMessage}`);
	assert.ok(text(second).trim().length > 0, `${model.id} must answer after the tool results`);
	result.checks.reasoningRoundTrip = "accepted with reasoning replayed";

	if (capabilities.input.images) {
		const image = await call(routed, {
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "What color is the circle? Answer with one word." },
						{ type: "image", data: redCircle, mimeType: "image/png" },
					],
					timestamp: Date.now(),
				},
			],
		});
		assert.equal(image.stopReason, "stop", `${model.id} image: ${image.errorMessage}`);
		assert.match(text(image), /red/i);
		result.checks.image = "stop; named the color";
	}

	const unsupportedEffort = model.api === "openai-completions" ? "xhigh" : "none";
	if (model.reasoning && model.thinkingLevelMap?.[unsupportedEffort === "none" ? "off" : "xhigh"] === null) {
		const rejected = await streamSimple(
			routed,
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{
				apiKey: token,
				maxRetries: 0,
				reasoning: "low",
				onPayload: (payload) =>
					model.api === "openai-completions"
						? { ...(payload as object), reasoning_effort: unsupportedEffort }
						: { ...(payload as object), reasoning: { effort: unsupportedEffort } },
			},
		).result();
		const error = getGitHubCopilotError(rejected);
		if (rejected.stopReason === "error") {
			assert.equal(error?.code, "invalid-request", `${model.id}: ${rejected.errorMessage}`);
			result.checks.unsupportedEffort = `${error?.code} (${(error as { reason?: string }).reason})`;
		} else {
			result.checks.unsupportedEffort = `accepted ${unsupportedEffort}`;
		}
	}
	return result;
}

describe.skipIf(!token)("GitHub Copilot live smoke for non-OpenAI, non-Anthropic families (#4324)", async () => {
	const account = token ? await readAccountModels() : { entries: [], raw: { data: [] } };
	const listed = new Map(account.entries.map((entry) => [entry.id, entry]));
	const catalog = (getModels("github-copilot") as Model<Api>[]).filter((model) =>
		FAMILY_PREFIXES.some((prefix) => model.id.startsWith(prefix)),
	);
	const discovered = parseGitHubCopilotDiscoveredModels(account.raw, getModels("github-copilot")).filter((model) => {
		const vendor = listed.get(model.id)?.vendor;
		return vendor !== undefined && !OTHER_VENDORS.has(vendor);
	});

	it.each(catalog.map((model) => ({ id: model.id, model })))(
		"catalog $id",
		async ({ model }) => {
			const entry = listed.get(model.id);
			if (!entry) {
				const routed: Model<Api> = { ...model, baseUrl: baseUrl ?? model.baseUrl };
				const attempt = await streamSimple(
					routed,
					{ messages: [{ role: "user", content: "Reply with the single word: ready", timestamp: Date.now() }] },
					{ apiKey: token, maxTokens: 64, maxRetries: 0 },
				).result();
				if (attempt.stopReason === "stop") {
					results.push(await smoke(model, "catalog (answered although unlisted)"));
					report();
					return;
				}
				const error = getGitHubCopilotError(attempt);
				assert.ok(error instanceof GitHubCopilotModelUnavailableError, `${model.id}: ${attempt.errorMessage}`);
				assert.ok(UNAVAILABLE_REASONS.includes(error.reason), `${model.id}: ${error.reason}`);
				assert.equal(error.modelId, model.id);
				assert.equal(error.retryable, false);
				assert.equal(error.status, 400);
				results.push({
					model: model.id,
					family: "catalog",
					api: model.api,
					status: "not entitled",
					checks: {
						rejection: `${error.code} (${error.reason}), HTTP ${error.status}, provider code ${error.providerCode ?? "none"}`,
					},
				});
				report();
				return;
			}
			// The account's own endpoints and the catalog's metadata route the model to the same API.
			const rawEntry = (account.raw as { data: Array<{ id?: unknown }> }).data.find((item) => item.id === model.id);
			const [fromAccount] = parseGitHubCopilotDiscoveredModels({ data: [rawEntry] }, []);
			if (fromAccount) assert.equal(fromAccount.api, model.api, `${model.id}: ${entry.endpoints.join(", ")}`);
			results.push(await smoke(model, "catalog"));
			report();
		},
		LIVE_COPILOT_FAMILY_TIMEOUT_MS,
	);

	it.each(discovered.map((model) => ({ id: model.id, model })))(
		"discovered $id",
		async ({ model }) => {
			results.push(await smoke(model, `discovered (${listed.get(model.id)?.vendor})`));
			report();
		},
		LIVE_COPILOT_FAMILY_TIMEOUT_MS,
	);

	it(
		"types an unknown model as model-unavailable",
		async () => {
			const template = catalog.find((model) => model.api === "openai-completions") ?? catalog[0];
			assert.ok(template);
			const unknown: Model<Api> = {
				...template,
				id: "atomic-smoke-unknown-model",
				baseUrl: baseUrl ?? template.baseUrl,
			};
			const message = await streamSimple(
				unknown,
				{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
				{
					apiKey: token,
					maxRetries: 0,
				},
			).result();
			const error = getGitHubCopilotError(message);
			assert.equal(error?.code, "model-unavailable", message.errorMessage);
			results.push({
				model: unknown.id,
				family: "unknown",
				api: unknown.api,
				status: "passed",
				checks: { error: `${error?.code} (${(error as { reason?: string }).reason}), HTTP ${error?.status}` },
			});
			report();
		},
		LIVE_COPILOT_FAMILY_TIMEOUT_MS,
	);
});
