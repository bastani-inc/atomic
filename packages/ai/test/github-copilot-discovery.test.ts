import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, describe, it, vi } from "vitest";
import type { Credential, OAuthCredential } from "../src/auth/types.ts";
import { streamSimple } from "../src/compat.ts";
import type { Provider, RefreshModelsContext } from "../src/models.ts";
import {
	discoverGitHubCopilotModels,
	githubCopilotProvider,
	parseGitHubCopilotDiscoveredModels,
} from "../src/providers/github-copilot.ts";
import type { Api, Model } from "../src/types.ts";

/** A recorded `GET /models` response with account fields removed and every model renamed. */
const recordedModels: { data: Array<Record<string, unknown>> } = JSON.parse(
	readFileSync(new URL("./fixtures/github-copilot-models.json", import.meta.url), "utf8"),
);
const recordedIds = recordedModels.data.map((entry) => entry.id);

const staticModel: Model<"openai-responses"> = {
	id: "example-static-model",
	name: "Curated Example",
	api: "openai-responses",
	provider: "github-copilot",
	baseUrl: "https://api.individual.githubcopilot.com",
	reasoning: true,
	thinkingLevelMap: { off: null, minimal: null },
	input: ["text"],
	cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 400_000,
	maxTokens: 64_000,
};

function discover(raw: unknown = recordedModels, catalog: readonly Model<Api>[] = [staticModel]): Model<Api>[] {
	return parseGitHubCopilotDiscoveredModels(raw, catalog);
}

function discovered(id: string): Model<Api> {
	const model = discover().find((candidate) => candidate.id === id);
	if (!model) throw new Error(`Expected ${id} to be discovered`);
	return model;
}

function withEntry(id: string, changes: Record<string, unknown>): { data: Array<Record<string, unknown>> } {
	return {
		data: recordedModels.data.map((entry) => (entry.id === id ? { ...entry, ...changes } : entry)),
	};
}

function refreshContext(credential: Credential, baseUrl?: string): RefreshModelsContext {
	return {
		credential,
		publish: async () => true,
		allowNetwork: true,
		signal: new AbortController().signal,
		...(baseUrl ? { baseUrl } : {}),
	};
}

function stubModelList(response: () => Response): Request[] {
	const requests: Request[] = [];
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		requests.push(input instanceof Request ? input : new Request(input, init));
		return response();
	});
	return requests;
}

afterEach(() => vi.restoreAllMocks());

describe("GitHub Copilot account model discovery", () => {
	it("offers each model the catalog lacks under its exact advertised ID, in the account's order", () => {
		assert.deepEqual(
			discover().map((model) => model.id),
			[
				"example-static-model-fast",
				"example-model",
				"example-model-fast",
				"example-chat-model",
				"example-reasoning-model",
				"example-messages-model",
				"example-legacy-model",
			],
		);
	});

	it("never offers an ID the account's list does not contain", () => {
		for (const model of discover()) assert.ok(recordedIds.includes(model.id), model.id);
	});

	it("names each discovered model by the display name its list entry advertises, keeping the exact ID", () => {
		const displayNames = new Map(recordedModels.data.map((entry) => [entry.id, entry.name]));
		for (const model of discover()) {
			assert.equal(model.name, displayNames.get(model.id));
			assert.notEqual(model.name, model.id);
			assert.equal(model.discovered, true);
			assert.equal(model.provider, "github-copilot");
		}
		assert.equal(discovered("example-model").name, "Example Model");
	});

	it("falls back to the exact ID when a list entry advertises no usable display name", () => {
		for (const name of [undefined, "", "   ", 7]) {
			const raw = withEntry("example-chat-model", { name });
			const model = discover(raw).find((candidate) => candidate.id === "example-chat-model");
			assert.equal(model?.name, "example-chat-model");
		}
	});

	it("leaves a model the catalog already has to its curated entry", () => {
		assert.equal(
			discover().some((model) => model.id === "example-static-model"),
			false,
		);
		assert.equal(staticModel.name, "Curated Example");
		assert.equal(staticModel.contextWindow, 400_000);
	});

	it("skips entries with a disabled policy, hidden from the picker, without tool calls, or not chat", () => {
		const ids = discover().map((model) => model.id);
		for (const skipped of [
			"example-disabled-model",
			"example-disabled-model-fast",
			"example-hidden-model",
			"example-toolless-model",
			"example-embedding-model",
			"example-image-model",
			"example-decision-model",
		]) {
			assert.equal(ids.includes(skipped), false, skipped);
		}
	});

	it("skips an entry whose tool support is not advertised", () => {
		const raw = withEntry("example-model", {
			capabilities: { type: "chat", supports: { streaming: true }, limits: {} },
		});
		assert.equal(
			discover(raw).some((model) => model.id === "example-model"),
			false,
		);
	});

	it("skips a chat entry that lists none of the endpoints Atomic can call", () => {
		assert.equal(
			discover().some((model) => model.id === "example-unrouted-model"),
			false,
		);
	});

	it("picks the API from the advertised endpoints", () => {
		assert.equal(discovered("example-messages-model").api, "anthropic-messages");
		assert.equal(discovered("example-model").api, "openai-responses");
		assert.equal(discovered("example-reasoning-model").api, "openai-responses");
		assert.equal(discovered("example-chat-model").api, "openai-completions");
		assert.equal(discovered("example-legacy-model").api, "openai-completions");
		assert.deepEqual(discovered("example-chat-model").compat, {
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: true,
			supportsLongCacheRetention: false,
			supportsStrictMode: false,
		});
		assert.deepEqual(discovered("example-model").compat, {
			supportsLongCacheRetention: false,
			supportsStrictMode: true,
		});
	});

	it("sends strict tool schemas only to a model whose entry lists structured outputs (#4324)", () => {
		const entry = (supports: Record<string, unknown>, endpoints: string[]) => ({
			data: [{ id: "probe-model", supported_endpoints: endpoints, capabilities: { type: "chat", supports } }],
		});
		for (const endpoints of [["/chat/completions"], ["/responses"]]) {
			const [withStrict] = parseGitHubCopilotDiscoveredModels(
				entry({ tool_calls: true, structured_outputs: true }, endpoints),
				[],
			);
			const [withoutStrict] = parseGitHubCopilotDiscoveredModels(
				entry({ tool_calls: true, structured_outputs: false }, endpoints),
				[],
			);
			assert.equal((withStrict?.compat as { supportsStrictMode?: boolean } | undefined)?.supportsStrictMode, true);
			assert.equal(
				(withoutStrict?.compat as { supportsStrictMode?: boolean } | undefined)?.supportsStrictMode,
				false,
			);
		}
	});

	it("reads image limits from the entry's vision limits (#4324)", () => {
		assert.deepEqual(discovered("example-chat-model").inputLimits, {
			images: { maxPerRequest: 10, resize: { maxBytes: 4_194_304 } },
		});
		const parse = (supports: Record<string, unknown>, vision: Record<string, unknown> | undefined) =>
			parseGitHubCopilotDiscoveredModels(
				{
					data: [
						{
							id: "probe-model",
							supported_endpoints: ["/chat/completions"],
							capabilities: { type: "chat", supports, limits: { vision } },
						},
					],
				},
				[],
			)[0];
		// A larger per-image limit never raises Atomic's default resize cap.
		assert.deepEqual(parse({ tool_calls: true, vision: true }, { max_prompt_image_size: 30_000_000 })?.inputLimits, {
			images: { resize: { maxBytes: 4.5 * 1024 * 1024 } },
		});
		// 3 raw bytes encode to 4 base64 bytes; a partial group still takes 4.
		assert.deepEqual(parse({ tool_calls: true, vision: true }, { max_prompt_image_size: 4 })?.inputLimits, {
			images: { resize: { maxBytes: 8 } },
		});
		assert.deepEqual(parse({ tool_calls: true, vision: true }, { max_prompt_images: 2 })?.inputLimits, {
			images: { maxPerRequest: 2 },
		});
		assert.equal(parse({ tool_calls: true, vision: true }, {})?.inputLimits, undefined);
		const noLimits = parseGitHubCopilotDiscoveredModels(
			{
				data: [
					{
						id: "probe-model",
						supported_endpoints: ["/chat/completions"],
						capabilities: { type: "chat", supports: { tool_calls: true, vision: true } },
					},
				],
			},
			[],
		)[0];
		assert.deepEqual(noLimits?.input, ["text", "image"]);
		assert.equal(noLimits?.inputLimits, undefined);
		assert.equal(parse({ tool_calls: true, vision: true }, undefined)?.inputLimits, undefined);
		const textOnly = parse({ tool_calls: true }, { max_prompt_images: 2 });
		assert.deepEqual(textOnly?.input, ["text"]);
		assert.equal(textOnly?.inputLimits, undefined);
	});

	it("sends the selected effort to a Messages model the list marks as adaptive", async () => {
		let request: Request | undefined;
		await streamSimple(
			discovered("example-messages-model"),
			{ messages: [{ role: "user", content: "test", timestamp: 0 }] },
			{
				apiKey: "tid=test;exp=9999999999;proxy-ep=proxy.individual.githubcopilot.com",
				reasoning: "medium",
				fetch: async (input, init) => {
					request = input instanceof Request ? input : new Request(input, init);
					return Response.json(
						{ type: "error", error: { type: "invalid_request_error", message: "stop" } },
						{ status: 400 },
					);
				},
			},
		).result();
		assert(request);
		const payload = JSON.parse(await request.text()) as {
			model: string;
			thinking?: { type: string; budget_tokens?: number };
			output_config?: { effort?: string };
		};
		assert.equal(payload.model, "example-messages-model");
		assert.equal(payload.thinking?.type, "adaptive");
		assert.equal(payload.thinking?.budget_tokens, undefined);
		assert.equal(payload.output_config?.effort, "medium");
	});

	it("keeps budget-based thinking for a Messages model the list does not mark as adaptive", () => {
		const supports = { tool_calls: true, reasoning_effort: ["low", "medium", "high"] };
		const raw = withEntry("example-messages-model", {
			capabilities: { type: "chat", family: "example-messages-model", supports, limits: {} },
		});
		const model = discover(raw).find((candidate) => candidate.id === "example-messages-model");
		assert.equal(model?.api, "anthropic-messages");
		assert.equal(model?.compat, undefined);
	});

	it("reads limits, image input and reasoning efforts from the entry", () => {
		const model = discovered("example-reasoning-model");
		assert.equal(model.contextWindow, 1_000_000);
		assert.equal(model.maxTokens, 128_000);
		assert.deepEqual(model.input, ["text", "image"]);
		assert.equal(model.reasoning, true);
		assert.deepEqual(model.thinkingLevelMap, {
			off: "none",
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: "max",
		});
		assert.deepEqual(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

		const legacy = discovered("example-legacy-model");
		assert.equal(legacy.reasoning, false);
		assert.equal(legacy.thinkingLevelMap, undefined);
		assert.equal(legacy.contextWindow, 128_000);
		assert.equal(legacy.maxTokens, 4_096);
	});

	it("keeps a fast entry the catalog does not link to a base as an ordinary model under its exact ID", () => {
		// Its ID ends in `-fast` and a model with the rest of that ID is in the catalog, but the entry's
		// family is its own ID, so nothing makes the base explicit.
		const model = discovered("example-static-model-fast");
		assert.equal(model.fastRoute, undefined);
		assert.equal(model.api, "openai-responses");
		assert.equal(model.contextWindow, 1_050_000);
	});

	it("routes a fast entry whose family names another model as that model's fast variant", () => {
		const model = discovered("example-model-fast");
		assert.deepEqual(model.fastRoute, { baseModelId: "example-model", upstreamModelId: "example-model-fast" });
		assert.equal(model.name, "Example Model Fast");
		assert.equal(model.api, discovered("example-model").api);

		const fast = linkedToCatalog();
		assert.deepEqual(fast.fastRoute, {
			baseModelId: "example-static-model",
			upstreamModelId: "example-static-model-fast",
		});
		assert.equal(fast.name, "Example Static Model Fast");
	});

	it("describes a linked fast entry by its own row, not its base's", () => {
		// The curated base differs from the fast entry's row in limits, image input and efforts.
		const fast = linkedToCatalog();
		assert.equal(fast.api, "openai-responses");
		assert.equal(fast.contextWindow, 1_050_000);
		assert.equal(fast.maxTokens, 128_000);
		assert.deepEqual(fast.input, ["text", "image"]);
		assert.equal(fast.thinkingLevelMap?.xhigh, "xhigh");
		assert.deepEqual(fast.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		assert.equal(fast.discovered, true);
	});

	it("rejects a response without a model list", () => {
		assert.throws(() => discover({ object: "list" }), /Invalid GitHub Copilot models response/);
	});

	it("sends a discovered fast model upstream under its exact ID without a 24-hour cache request", async () => {
		for (const model of [
			discovered("example-static-model-fast"),
			discovered("example-model-fast"),
			linkedToCatalog(),
		]) {
			let request: Request | undefined;
			await streamSimple(
				model,
				{ messages: [{ role: "user", content: "test", timestamp: 0 }] },
				{
					apiKey: "tid=test;exp=9999999999;proxy-ep=proxy.individual.githubcopilot.com",
					cacheRetention: "long",
					fetch: async (input, init) => {
						request = input instanceof Request ? input : new Request(input, init);
						return new Response(
							`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 } } })}\n\n`,
							{ status: 200, headers: { "content-type": "text/event-stream" } },
						);
					},
				},
			).result();
			assert(request);
			const payload = JSON.parse(await request.text()) as {
				model: string;
				service_tier?: string;
				prompt_cache_retention?: string;
			};
			assert.equal(payload.model, model.id);
			assert.equal(payload.service_tier, undefined);
			// Some Copilot models reject a 24-hour cache request, and the account's list cannot say which.
			assert.equal(payload.prompt_cache_retention, undefined, model.id);
		}
	});
});

/** The recorded fast entry whose family names the curated catalog model as its base. */
function linkedToCatalog(): Model<Api> {
	const raw = withEntry("example-static-model-fast", { capabilities: familyOf("example-static-model") });
	const fast = discover(raw).find((candidate) => candidate.id === "example-static-model-fast");
	if (!fast) throw new Error("Expected example-static-model-fast to be discovered");
	return fast;
}

function familyOf(family: string): Record<string, unknown> {
	const entry = recordedModels.data.find((candidate) => candidate.id === "example-static-model-fast");
	return { ...(entry?.capabilities as Record<string, unknown>), family };
}

describe("discoverGitHubCopilotModels", () => {
	it("reads an API key's list from the provider's configured host with the raw-token integration ID", async () => {
		const requests = stubModelList(() => Response.json(recordedModels));
		const models = await discoverGitHubCopilotModels(
			[staticModel],
			refreshContext({ type: "api_key", key: "github-token" }, "https://api.githubcopilot.com/"),
		);

		assert.equal(models?.length, 7);
		assert.equal(requests.length, 1);
		assert.equal(requests[0]?.url, "https://api.githubcopilot.com/models");
		assert.equal(requests[0]?.headers.get("Authorization"), "Bearer github-token");
		assert.equal(requests[0]?.headers.get("Copilot-Integration-Id"), "copilot-developer-cli");
		assert.equal(requests[0]?.headers.get("X-GitHub-Api-Version"), "2026-06-01");
	});

	it("reads an OAuth login's list from the host its token names", async () => {
		const requests = stubModelList(() => Response.json(recordedModels));
		const access = "tid=test;exp=9999999999;proxy-ep=proxy.business.githubcopilot.com";
		const models = await discoverGitHubCopilotModels(
			[staticModel],
			refreshContext(
				{ type: "oauth", access, refresh: "refresh-token", expires: Number.MAX_SAFE_INTEGER },
				"https://api.individual.githubcopilot.com",
			),
		);

		assert.equal(models?.length, 7);
		assert.equal(requests[0]?.url, "https://api.business.githubcopilot.com/models");
		assert.equal(requests[0]?.headers.get("Authorization"), `Bearer ${access}`);
		assert.equal(requests[0]?.headers.get("Copilot-Integration-Id"), "vscode-chat");
	});

	it("saves the account's model lists to the OAuth login that read them", async () => {
		stubModelList(() => Response.json(recordedModels));
		const login: OAuthCredential = {
			type: "oauth",
			access: "tid=test;exp=9999999999;proxy-ep=proxy.individual.githubcopilot.com",
			refresh: "refresh-token",
			expires: Number.MAX_SAFE_INTEGER,
			availableModelIds: ["example-static-model"],
			fastModelIds: [],
		};
		const updates: Array<(current: OAuthCredential) => OAuthCredential | undefined> = [];
		await discoverGitHubCopilotModels([staticModel], {
			...refreshContext(login),
			updateCredential: async (update) => {
				updates.push(update);
			},
		});

		assert.equal(updates.length, 1);
		const saved = updates[0]?.(login);
		assert.deepEqual(saved, {
			...login,
			availableModelIds: [
				"example-static-model",
				"example-static-model-fast",
				"example-model",
				"example-chat-model",
				"example-reasoning-model",
				"example-messages-model",
				"example-legacy-model",
				"example-unrouted-model",
			],
			fastModelIds: ["example-static-model-fast", "example-model-fast"],
		});
		// A login whose lists already match is left as it is.
		assert.equal(saved && updates[0]?.(saved), undefined);
	});

	it.each([400, 401, 403, 404])(
		"reports no list, not an empty one, when the host refuses the token (%i)",
		async (status) => {
			stubModelList(() => new Response("refused", { status }));
			const models = await discoverGitHubCopilotModels([staticModel], refreshContext({ type: "api_key", key: "k" }));
			assert.equal(models, undefined);
		},
	);

	it("fails on other errors so the cached list is kept", async () => {
		stubModelList(() => new Response("unavailable", { status: 503 }));
		await assert.rejects(
			discoverGitHubCopilotModels([staticModel], refreshContext({ type: "api_key", key: "k" })),
			/GitHub Copilot model list request failed: 503/,
		);
	});

	it("reports no list without a credential", async () => {
		const requests = stubModelList(() => Response.json(recordedModels));
		const models = await discoverGitHubCopilotModels([staticModel], {
			publish: async () => true,
			allowNetwork: true,
			signal: new AbortController().signal,
		});
		assert.equal(models, undefined);
		assert.equal(requests.length, 0);
	});
});

describe("GitHub Copilot availability of discovered models", () => {
	const provider: Provider = githubCopilotProvider();
	const fast = discovered("example-model-fast");
	const unlinkedFast = discovered("example-static-model-fast");
	const ordinary = discovered("example-model");

	it("offers every discovered model to an API key", () => {
		const available = provider.filterModels?.([ordinary, fast, unlinkedFast], { type: "api_key", key: "k" });
		assert.deepEqual(
			available?.map((model) => model.id),
			["example-model", "example-model-fast", "example-static-model-fast"],
		);
	});

	it("offers a login the fast IDs it lists, picker entries or not, and only those", () => {
		const login = {
			type: "oauth" as const,
			access: "copilot-test",
			refresh: "unused",
			expires: 0,
			availableModelIds: ["example-model"],
			fastModelIds: ["example-model-fast", "example-static-model-fast"],
		};
		assert.deepEqual(
			provider.filterModels?.([ordinary, fast, unlinkedFast], login)?.map((model) => model.id),
			["example-model", "example-model-fast", "example-static-model-fast"],
		);
		assert.deepEqual(
			provider
				.filterModels?.([ordinary, fast, unlinkedFast], { ...login, fastModelIds: [] })
				?.map((model) => model.id),
			["example-model"],
		);
	});
});
