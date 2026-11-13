import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Credential } from "@bastani/pi-ai";
import { GITHUB_COPILOT_MODELS } from "@bastani/pi-ai/providers/github-copilot.models";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import { listModels } from "../src/cli/list-models.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import {
	findInitialModel,
	resolveCliModel,
	resolveModelScopeWithDiagnostics,
	restoreModelFromSession,
} from "../src/core/model-resolver.js";
import { ModelRuntime } from "../src/core/model-runtime.js";
import { createAgentSession } from "../src/core/sdk.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { BUILTIN_PATH_PREFIX } from "../src/core/source-info.js";
import { resolveDeferredStartupModel } from "../src/main-deferred-startup.js";

const PROVIDER = "github-copilot";
const API_KEY: Credential = { type: "api_key", key: "github_pat_example_token" };
const OAUTH_ACCESS = "tid=example;exp=9999999999;proxy-ep=proxy.individual.githubcopilot.com";
/** A real built-in Copilot model, read from the catalog so the test names no model itself. */
const CATALOG_MODEL_ID = Object.keys(GITHUB_COPILOT_MODELS)[0] ?? "";
const NO_BUILTINS = { workflows: false, subagents: false, mcp: false, "web-access": false, intercom: false } as const;

function accountEntry(
	id: string,
	options: { family?: string; endpoints?: string[]; picker?: boolean } = {},
): Record<string, unknown> {
	return {
		id,
		name: `Display name of ${id}`,
		object: "model",
		vendor: "Example Vendor",
		version: id,
		preview: false,
		model_picker_enabled: options.picker ?? true,
		policy: { state: "enabled", terms: "" },
		supported_endpoints: options.endpoints ?? ["/responses"],
		capabilities: {
			family: options.family ?? id,
			object: "model_capabilities",
			type: "chat",
			tokenizer: "o200k_base",
			limits: { max_context_window_tokens: 400_000, max_prompt_tokens: 272_000, max_output_tokens: 64_000 },
			supports: { streaming: true, tool_calls: true, vision: true, reasoning_effort: ["low", "medium", "high"] },
		},
	};
}

/** The account's list: an ordinary model, a fast entry the list does not link to a base, and one it does. */
const ACCOUNT_MODELS = {
	object: "list",
	data: [
		accountEntry("example-model", { family: "example-family", endpoints: ["/chat/completions", "/responses"] }),
		accountEntry("example-model-fast"),
		accountEntry("example-linked-model-fast", { family: "example-model", picker: false }),
	],
};
const ACCOUNT_IDS = ACCOUNT_MODELS.data.map((entry) => entry.id as string);

const oauthLogin = (fastModelIds: string[]): Credential => ({
	type: "oauth",
	access: OAUTH_ACCESS,
	refresh: "refresh-token",
	expires: Number.MAX_SAFE_INTEGER,
	availableModelIds: ["example-model", "example-model-fast", CATALOG_MODEL_ID],
	fastModelIds,
});

let agentDir: string;
let modelListUrls: string[];
let modelListAuthorizations: Array<string | null>;

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "atomic-copilot-discovery-"));
	modelListUrls = [];
	modelListAuthorizations = [];
});

afterEach(() => {
	vi.restoreAllMocks();
	rmSync(agentDir, { recursive: true, force: true });
});

function stubNetwork(
	modelList: (authorization: string | null) => Response = () => Response.json(ACCOUNT_MODELS),
): void {
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const request = input instanceof Request ? input : new Request(input, init);
		if (request.url.startsWith("https://pi.dev/")) return new Response("not found", { status: 404 });
		if (request.url.endsWith("/models")) {
			modelListUrls.push(request.url);
			const authorization = request.headers.get("Authorization");
			modelListAuthorizations.push(authorization);
			return modelList(authorization);
		}
		throw new Error(`Unexpected request: ${request.url}`);
	});
}

function blockNetwork() {
	return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
		throw new Error(`Offline startup made a request: ${String(input)}`);
	});
}

async function runtime(credential: Credential, modelsJson?: Record<string, unknown>): Promise<ModelRuntime> {
	writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ [PROVIDER]: credential }));
	if (modelsJson) writeFileSync(join(agentDir, "models.json"), JSON.stringify(modelsJson));
	return restart();
}

/** Start a new runtime from the credential and caches already on disk, without the network. */
async function restart(): Promise<ModelRuntime> {
	return ModelRuntime.create({
		credentials: AuthStorage.create(join(agentDir, "auth.json")),
		modelsPath: join(agentDir, "models.json"),
		allowModelNetwork: false,
	});
}

async function discover(credential: Credential, modelsJson?: Record<string, unknown>): Promise<ModelRuntime> {
	stubNetwork();
	const modelRuntime = await runtime(credential, modelsJson);
	const result = await modelRuntime.refresh({ providers: [PROVIDER], allowNetwork: true });
	assert.equal(result.errors.get(PROVIDER), undefined);
	vi.restoreAllMocks();
	return modelRuntime;
}

async function resumeSession(modelRuntime: ModelRuntime, modelId: string) {
	const cwd = join(agentDir, "project");
	mkdirSync(cwd, { recursive: true });
	const sessionManager = SessionManager.inMemory(cwd);
	await sessionManager.appendModelChange(PROVIDER, modelId);
	await sessionManager.appendMessage({ role: "user", content: [{ type: "text", text: "resume" }], timestamp: 0 });
	const resumed = await createAgentSession({
		cwd,
		agentDir,
		modelRuntime,
		sessionManager,
		settingsManager: SettingsManager.inMemory({}),
		builtins: NO_BUILTINS,
	});
	assert.deepEqual(
		resumed.extensionsResult.extensions
			.map((extension) => extension.path)
			.filter((path) => !path.startsWith(BUILTIN_PATH_PREFIX)),
		[],
	);
	return resumed;
}

async function availableIds(modelRuntime: ModelRuntime): Promise<string[]> {
	return (await modelRuntime.getAvailable(PROVIDER)).map((model) => model.id);
}

function assertIncludesAll(actual: readonly string[], expected: readonly string[]): void {
	for (const id of expected)
		assert.ok(actual.includes(id), `${id} is not among the ${actual.length} available models`);
}

function assertMentions(message: string | undefined, text: string): void {
	assert.ok(message?.includes(text), `${JSON.stringify(message)} does not mention ${JSON.stringify(text)}`);
}

describe("GitHub Copilot models discovered from the account's list", () => {
	it("reads an API key's list from its routed host and offers each model under its exact ID and display name", async () => {
		const modelRuntime = await discover(API_KEY);

		assert.deepEqual(modelListUrls, ["https://api.githubcopilot.com/models"]);
		assert.deepEqual(modelListAuthorizations, [`Bearer ${API_KEY.type === "api_key" ? API_KEY.key : ""}`]);
		assertIncludesAll(await availableIds(modelRuntime), ACCOUNT_IDS);
		for (const id of ACCOUNT_IDS) {
			const model = modelRuntime.getModel(PROVIDER, id);
			assert.equal(model?.id, id);
			assert.equal(model?.name, `Display name of ${id}`);
			assert.equal(model?.discovered, true);
		}
		assert.equal(modelRuntime.getModel(PROVIDER, CATALOG_MODEL_ID)?.discovered, undefined);
	});

	it("keeps a fast model the list does not link to a base as an ordinary model", async () => {
		const modelRuntime = await discover(API_KEY);

		assert.equal(modelRuntime.getModel(PROVIDER, "example-model-fast")?.fastRoute, undefined);
		assert.deepEqual(modelRuntime.getModel(PROVIDER, "example-linked-model-fast")?.fastRoute, {
			baseModelId: "example-model",
			upstreamModelId: "example-linked-model-fast",
		});
	});

	it("reads an OAuth login's list from its token's host and derives no fast ID the list does not contain", async () => {
		const unlisted = `${CATALOG_MODEL_ID}-fast`;
		const modelRuntime = await discover(oauthLogin(["example-linked-model-fast", "example-model-fast", unlisted]));

		assert.deepEqual(modelListUrls, ["https://api.individual.githubcopilot.com/models"]);
		assert.deepEqual(modelListAuthorizations, [`Bearer ${OAUTH_ACCESS}`]);
		assertIncludesAll(await availableIds(modelRuntime), ACCOUNT_IDS);
		assert.equal(modelRuntime.getModel(PROVIDER, unlisted), undefined);
		for (const id of modelRuntime.getModels(PROVIDER).map((model) => model.id)) {
			assert.ok(id in GITHUB_COPILOT_MODELS || ACCOUNT_IDS.includes(id), id);
		}
	});

	it("offers what a refresh discovers to an OAuth login whose saved lists predate it, also after a restart", async () => {
		// The token is still valid, so the refresh reads the account's list without renewing the login.
		const staleLogin: Credential = {
			type: "oauth",
			access: OAUTH_ACCESS,
			refresh: "refresh-token",
			expires: Number.MAX_SAFE_INTEGER,
			availableModelIds: [CATALOG_MODEL_ID],
			fastModelIds: [],
		};
		const modelRuntime = await discover(staleLogin);

		assert.deepEqual(modelListUrls, ["https://api.individual.githubcopilot.com/models"]);
		assertIncludesAll(await availableIds(modelRuntime), ACCOUNT_IDS);

		blockNetwork();
		assertIncludesAll(await availableIds(await restart()), ACCOUNT_IDS);
	});

	it("does not offer the models a previous login discovered to a different login", async () => {
		await discover(oauthLogin(["example-model-fast", "example-linked-model-fast"]));
		blockNetwork();

		const otherLogin: Credential = {
			type: "oauth",
			access: "tid=other;exp=9999999999;proxy-ep=proxy.individual.githubcopilot.com",
			refresh: "other-refresh-token",
			expires: Number.MAX_SAFE_INTEGER,
			availableModelIds: [CATALOG_MODEL_ID],
			fastModelIds: [],
		};
		const available = await availableIds(await runtime(otherLogin));

		for (const id of ACCOUNT_IDS) assert.equal(available.includes(id), false, id);
		assert.ok(available.includes(CATALOG_MODEL_ID));
	});

	it("restores the discovered models at startup without the network", async () => {
		await discover(API_KEY);
		const fetchSpy = blockNetwork();

		const restarted = await runtime(API_KEY);

		assert.equal(restarted.getModel(PROVIDER, "example-model-fast")?.discovered, true);
		assertIncludesAll(await availableIds(restarted), ACCOUNT_IDS);
		assert.equal(fetchSpy.mock.calls.length, 0);
	});

	it.each([400, 401, 403, 404])(
		"keeps the cached models when a later refresh is refused the account's list (%i)",
		async (status) => {
			await discover(API_KEY);
			stubNetwork(() => new Response("refused", { status }));
			const modelRuntime = await restart();

			const result = await modelRuntime.refresh({ providers: [PROVIDER], allowNetwork: true });

			assert.equal(result.errors.get(PROVIDER), undefined);
			assert.deepEqual(modelListUrls.length, 2);
			assertIncludesAll(await availableIds(modelRuntime), ACCOUNT_IDS);
			vi.restoreAllMocks();
			blockNetwork();
			assertIncludesAll(await availableIds(await restart()), ACCOUNT_IDS);
		},
	);

	it("applies modelOverrides to a discovered model", async () => {
		const modelRuntime = await discover(API_KEY, {
			providers: {
				[PROVIDER]: {
					modelOverrides: {
						"example-model": {
							contextWindow: 12_345,
							maxTokens: 2_048,
							compat: { supportsLongCacheRetention: true },
						},
					},
				},
			},
		});

		const model = (await modelRuntime.getAvailable(PROVIDER)).find((entry) => entry.id === "example-model");
		assert.equal(model?.contextWindow, 12_345);
		assert.equal(model?.maxTokens, 2_048);
		assert.deepEqual(model?.compat, { supportsLongCacheRetention: true, supportsStrictMode: false });
		assert.equal(model?.discovered, true);
	});
});

describe("saved GitHub Copilot fast model selections", () => {
	const SAVED_ID = "example-model-fast";

	it.each([
		["an API key", API_KEY],
		["an OAuth login", oauthLogin([SAVED_ID])],
	])("resolve to the same ID through the cached list with %s", async (_label, credential) => {
		await discover(credential);
		blockNetwork();
		const modelRuntime = await runtime(credential);

		const initial = await findInitialModel({
			scopedModels: [],
			isContinuing: false,
			defaultProvider: PROVIDER,
			defaultModelId: SAVED_ID,
			modelRuntime,
		});
		assert.equal(initial.model?.id, SAVED_ID);
		assert.equal(initial.fallbackMessage, undefined);

		const restored = await restoreModelFromSession(PROVIDER, SAVED_ID, undefined, false, modelRuntime);
		assert.equal(restored.model?.id, SAVED_ID);
		assert.equal(restored.fallbackMessage, undefined);

		const cli = resolveCliModel({ cliModel: `${PROVIDER}/${SAVED_ID}`, modelRuntime });
		assert.equal(cli.model?.id, SAVED_ID);
		assert.equal(cli.warning, undefined);

		const { scopedModels: scoped, diagnostics: savedScopeDiagnostics } = await resolveModelScopeWithDiagnostics(
			[`${PROVIDER}/${SAVED_ID}`],
			modelRuntime,
		);
		assert.deepEqual(
			scoped.map((entry) => entry.model.id),
			[SAVED_ID],
		);
		assert.deepEqual(savedScopeDiagnostics, []);

		const resumed = await resumeSession(modelRuntime, SAVED_ID);
		assert.equal(resumed.session.model?.id, SAVED_ID);
		assert.equal(resumed.modelFallbackMessage, undefined);
		resumed.session.dispose();

		const deferred = await deferredStartupModel(modelRuntime, SAVED_ID);
		assert.equal(deferred?.id, SAVED_ID);
	});

	it.each([
		["an API key", API_KEY],
		["an OAuth login", oauthLogin([SAVED_ID])],
	])(
		"keep the saved choice through the startup pass deferred for project trust with %s",
		async (_label, credential) => {
			blockNetwork();
			const modelRuntime = await runtime(credential);
			// The configured default is usable, so only the stop for an uncached model keeps it from replacing the choice.
			assert.ok(modelRuntime.getModel(PROVIDER, CATALOG_MODEL_ID));

			assert.equal(await deferredStartupModel(modelRuntime, SAVED_ID), undefined);
		},
	);

	it.each([
		["an API key", API_KEY],
		["an OAuth login", oauthLogin([SAVED_ID])],
	])("fail with a refresh hint before the list is cached with %s", async (_label, credential) => {
		blockNetwork();
		const modelRuntime = await runtime(credential);

		const initial = await findInitialModel({
			scopedModels: [],
			isContinuing: false,
			defaultProvider: PROVIDER,
			defaultModelId: SAVED_ID,
			modelRuntime,
		});
		assert.equal(initial.model, undefined);
		assert.equal(initial.fallbackReason, "configured-provider-unsupported");
		assertMentions(initial.fallbackMessage, `${PROVIDER}/${SAVED_ID}`);
		assertMentions(initial.fallbackMessage, "update --models");

		assert.equal(modelRuntime.canRestoreUnknownModel(PROVIDER, SAVED_ID), false);
		const restored = await restoreModelFromSession(PROVIDER, SAVED_ID, undefined, false, modelRuntime);
		assert.notEqual(restored.model?.id, SAVED_ID);
		assertMentions(restored.fallbackMessage, `Could not restore model ${PROVIDER}/${SAVED_ID}`);
		assertMentions(restored.fallbackMessage, "update --models");

		// The reason blocks prompts (print mode exits with the message) instead of switching models.
		const resumed = await resumeSession(modelRuntime, SAVED_ID);
		assert.notEqual(resumed.session.model?.id, SAVED_ID);
		assert.equal(resumed.modelFallbackReason, "configured-provider-unsupported");
		assertMentions(resumed.modelFallbackMessage, `Could not restore model ${PROVIDER}/${SAVED_ID}`);
		assertMentions(resumed.modelFallbackMessage, "update --models");
		resumed.session.dispose();
	});
});

/** The model the startup pass deferred for project trust picks for a session that saved `modelId`. */
function deferredStartupModel(modelRuntime: ModelRuntime, modelId: string) {
	return resolveDeferredStartupModel({
		selected: undefined,
		isContinuing: true,
		savedModel: { provider: PROVIDER, modelId },
		settingsManager: SettingsManager.inMemory({ defaultProvider: PROVIDER, defaultModel: CATALOG_MODEL_ID }),
		modelRuntime,
	});
}

const CATALOG_IDS = Object.keys(GITHUB_COPILOT_MODELS);
/** A second real catalog model, which the account lists below leave out. */
const UNLISTED_CATALOG_MODEL_ID = CATALOG_IDS.find((id) => id !== CATALOG_MODEL_ID) ?? "";

function accountList(...ids: string[]): { object: string; data: Array<Record<string, unknown>> } {
	return { object: "list", data: ids.map((id) => accountEntry(id)) };
}

/** Discover an account's models from `list`, then leave the runtime without a network. */
async function discoverList(credential: Credential, list: unknown): Promise<ModelRuntime> {
	stubNetwork(() => Response.json(list));
	const modelRuntime = await runtime(credential);
	const result = await modelRuntime.refresh({ providers: [PROVIDER], allowNetwork: true });
	assert.equal(result.errors.get(PROVIDER), undefined);
	vi.restoreAllMocks();
	return modelRuntime;
}

function sorted(ids: readonly string[]): string[] {
	return [...ids].sort();
}

describe("GitHub Copilot availability by an API key's account list (#4627)", () => {
	const LISTED = [CATALOG_MODEL_ID, "example-model"];

	it("hides the catalog models an API key's account list omits and keeps the listed and discovered ones (#4627)", async () => {
		const modelRuntime = await discoverList(API_KEY, accountList(...LISTED));

		assert.ok(UNLISTED_CATALOG_MODEL_ID);
		assert.deepEqual(sorted(await availableIds(modelRuntime)), sorted(LISTED));
		assert.equal(modelRuntime.getModel(PROVIDER, "example-model")?.discovered, true);
		assert.equal(modelRuntime.getModel(PROVIDER, CATALOG_MODEL_ID)?.discovered, undefined);
	});

	it("applies the account's list to the model snapshot, --list-models and scoped models (#4627)", async () => {
		const modelRuntime = await discoverList(API_KEY, accountList(...LISTED));

		assert.deepEqual(sorted(modelRuntime.getAvailableSnapshot().map((model) => model.id)), sorted(LISTED));

		const lines: string[] = [];
		vi.spyOn(console, "log").mockImplementation((line: unknown) => {
			lines.push(String(line));
		});
		await listModels(modelRuntime, undefined, SettingsManager.inMemory({}));
		const listed = lines.map((line) => line.split("\t")[0]).slice(1);
		assert.deepEqual(sorted(listed), sorted(LISTED.map((id) => `${PROVIDER}/${id}`)));

		const { scopedModels: scoped, diagnostics: unlistedDiagnostics } = await resolveModelScopeWithDiagnostics(
			[`${PROVIDER}/*`, `${PROVIDER}/${UNLISTED_CATALOG_MODEL_ID}`],
			modelRuntime,
		);
		assert.deepEqual(sorted(scoped.map((entry) => entry.model.id)), sorted(LISTED));
		assert.equal(unlistedDiagnostics.length, 1);
		assert.equal(unlistedDiagnostics[0]?.code, "no-match");
	});

	it("keeps an API key's lists across a restart without the network (#4627)", async () => {
		await discoverList(API_KEY, accountList(...LISTED));
		const fetchSpy = blockNetwork();

		const restarted = await restart();

		assert.deepEqual(sorted(await availableIds(restarted)), sorted(LISTED));
		assert.equal(fetchSpy.mock.calls.length, 0);
	});

	it("offers an API key what an OAuth login is offered from the same account list (#4627)", async () => {
		const list = accountList(...LISTED, "example-model-fast");
		const loginIds = await availableIds(await discoverList(oauthLogin(["example-model-fast"]), list));
		const apiKeyIds = await availableIds(await discoverList(API_KEY, list));

		assert.deepEqual(sorted(apiKeyIds), sorted(loginIds));
		assert.ok(apiKeyIds.includes("example-model-fast"));
		assert.equal(apiKeyIds.includes(UNLISTED_CATALOG_MODEL_ID), false);
	});

	it.each([
		["refused with 400", () => new Response("refused", { status: 400 })],
		["refused with 401", () => new Response("refused", { status: 401 })],
		["refused with 403", () => new Response("refused", { status: 403 })],
		["refused with 404", () => new Response("refused", { status: 404 })],
		["unavailable (503)", () => new Response("unavailable", { status: 503 })],
		[
			"unreachable",
			(): Response => {
				throw new Error("network down");
			},
		],
	])(
		"hides nothing while the account's list cannot be fetched (%s), then hides once it is read (#4627)",
		async (_label, failure) => {
			stubNetwork(failure);
			const modelRuntime = await runtime(API_KEY);
			await modelRuntime.refresh({ providers: [PROVIDER], allowNetwork: true });

			assertIncludesAll(await availableIds(modelRuntime), CATALOG_IDS);
			assert.deepEqual(
				modelRuntime.getAvailableSnapshot().filter((model) => model.provider === PROVIDER).length,
				CATALOG_IDS.length,
			);

			vi.restoreAllMocks();
			stubNetwork(() => Response.json(accountList(...LISTED)));
			await modelRuntime.refresh({ providers: [PROVIDER], allowNetwork: true });

			assert.deepEqual(sorted(await availableIds(modelRuntime)), sorted(LISTED));
		},
	);

	it("hides nothing offline before the account's list was ever read (#4627)", async () => {
		const fetchSpy = blockNetwork();

		const modelRuntime = await runtime(API_KEY);

		assertIncludesAll(await availableIds(modelRuntime), CATALOG_IDS);
		assert.equal(fetchSpy.mock.calls.length, 0);
	});

	it("keeps the lists it read when a later refresh is refused, until a new key replaces the credential (#4627)", async () => {
		await discoverList(API_KEY, accountList(...LISTED));
		stubNetwork(() => new Response("expired", { status: 401 }));
		const modelRuntime = await restart();
		await modelRuntime.refresh({ providers: [PROVIDER], allowNetwork: true });

		assert.deepEqual(sorted(await availableIds(modelRuntime)), sorted(LISTED));

		vi.restoreAllMocks();
		blockNetwork();
		const otherKey: Credential = { type: "api_key", key: "github_pat_other_token" };
		assertIncludesAll(await availableIds(await runtime(otherKey)), CATALOG_IDS);
	});

	it("does not write the lists when the stored key is not the one the refresh read (#4627)", async () => {
		stubNetwork(() => {
			writeFileSync(
				join(agentDir, "auth.json"),
				JSON.stringify({ [PROVIDER]: { type: "api_key", key: "github_pat_other_token" } }),
			);
			return Response.json(accountList(...LISTED));
		});
		const modelRuntime = await runtime(API_KEY);
		await modelRuntime.refresh({ providers: [PROVIDER], allowNetwork: true });
		vi.restoreAllMocks();
		blockNetwork();

		assertIncludesAll(await availableIds(await restart()), CATALOG_IDS);
	});

	it.each([
		["a list with no model", { object: "list", data: [] }],
		[
			"a list whose models are all hidden from the picker",
			{ object: "list", data: [accountEntry("example-model", { picker: false })] },
		],
	])("hides nothing on %s (#4627)", async (_label, list) => {
		const modelRuntime = await discoverList(API_KEY, list);

		assertIncludesAll(await availableIds(modelRuntime), CATALOG_IDS);
	});

	it("keeps the lists of an OAuth login that reads the account's list (#4627)", async () => {
		const modelRuntime = await discoverList(oauthLogin(["example-model-fast"]), accountList(...LISTED));

		assert.deepEqual(sorted(await availableIds(modelRuntime)), sorted(LISTED));
	});

	it("keeps an OAuth login's catalog while it has no saved list (#4627)", async () => {
		const olderLogin: Credential = {
			type: "oauth",
			access: OAUTH_ACCESS,
			refresh: "refresh-token",
			expires: Number.MAX_SAFE_INTEGER,
		};
		blockNetwork();

		assertIncludesAll(await availableIds(await runtime(olderLogin)), CATALOG_IDS);
	});
});

describe("GitHub Copilot provider aliases and the account's list (#4627)", () => {
	const ALIAS = "copilot-work";
	const SOURCE_KEY = "github_pat_source_token";
	const ALIAS_KEY = "github_pat_alias_token";
	const SOURCE_LIST = accountList(CATALOG_MODEL_ID, "example-model");
	const ALIAS_LIST = accountList(UNLISTED_CATALOG_MODEL_ID, "example-model");
	const listsByToken = (lists: Record<string, unknown>) => (authorization: string | null) => {
		const list = lists[authorization?.replace("Bearer ", "") ?? ""];
		return list === undefined ? new Response("refused", { status: 401 }) : Response.json(list);
	};

	async function aliasRuntime(credentials: Record<string, Credential>): Promise<ModelRuntime> {
		writeFileSync(join(agentDir, "auth.json"), JSON.stringify(credentials));
		const modelRuntime = await restart();
		modelRuntime.registerProvider(ALIAS, { aliasOf: PROVIDER });
		await modelRuntime.whenRegistrationRefreshesSettled();
		return modelRuntime;
	}

	async function aliasIds(modelRuntime: ModelRuntime): Promise<string[]> {
		return (await modelRuntime.getAvailable(ALIAS)).map((model) => model.id);
	}

	it("filters each provider by the list its own credential reads (#4627)", async () => {
		stubNetwork(listsByToken({ [SOURCE_KEY]: SOURCE_LIST, [ALIAS_KEY]: ALIAS_LIST }));
		const modelRuntime = await aliasRuntime({
			[PROVIDER]: { type: "api_key", key: SOURCE_KEY },
			[ALIAS]: { type: "api_key", key: ALIAS_KEY },
		});

		const result = await modelRuntime.refresh({ providers: [PROVIDER, ALIAS], allowNetwork: true });

		assert.equal(result.errors.size, 0);
		assert.deepEqual(sorted(modelListAuthorizations), sorted([`Bearer ${SOURCE_KEY}`, `Bearer ${ALIAS_KEY}`]));
		assert.deepEqual(sorted(await availableIds(modelRuntime)), sorted([CATALOG_MODEL_ID, "example-model"]));
		assert.deepEqual(sorted(await aliasIds(modelRuntime)), sorted([UNLISTED_CATALOG_MODEL_ID, "example-model"]));

		vi.restoreAllMocks();
		blockNetwork();
		const restarted = await restart();
		restarted.registerProvider(ALIAS, { aliasOf: PROVIDER });
		await restarted.whenRegistrationRefreshesSettled();
		assert.deepEqual(sorted(await aliasIds(restarted)), sorted([UNLISTED_CATALOG_MODEL_ID, "example-model"]));
	});

	it("hides nothing for an alias whose list cannot be fetched while its source's list applies (#4627)", async () => {
		stubNetwork(listsByToken({ [SOURCE_KEY]: SOURCE_LIST }));
		const modelRuntime = await aliasRuntime({
			[PROVIDER]: { type: "api_key", key: SOURCE_KEY },
			[ALIAS]: { type: "api_key", key: ALIAS_KEY },
		});

		await modelRuntime.refresh({ providers: [PROVIDER, ALIAS], allowNetwork: true });

		assert.deepEqual(sorted(await availableIds(modelRuntime)), sorted([CATALOG_MODEL_ID, "example-model"]));
		assertIncludesAll(await aliasIds(modelRuntime), [...CATALOG_IDS, "example-model"]);
	});

	it("reads an alias's list when its source has no credential of its own (#4627)", async () => {
		stubNetwork(listsByToken({ [ALIAS_KEY]: ALIAS_LIST }));
		const modelRuntime = await aliasRuntime({ [ALIAS]: { type: "api_key", key: ALIAS_KEY } });

		await modelRuntime.refresh({ providers: [ALIAS], allowNetwork: true });

		assert.deepEqual(modelListAuthorizations, [`Bearer ${ALIAS_KEY}`]);
		assert.deepEqual(sorted(await aliasIds(modelRuntime)), sorted([UNLISTED_CATALOG_MODEL_ID]));
	});

	it("reads no Copilot list for an alias of another provider (#4627)", async () => {
		stubNetwork(listsByToken({ "sk-test": SOURCE_LIST }));
		writeFileSync(
			join(agentDir, "auth.json"),
			JSON.stringify({ "openai-work": { type: "api_key", key: "sk-test" } }),
		);
		const modelRuntime = await restart();
		modelRuntime.registerProvider("openai-work", { aliasOf: "openai" });
		await modelRuntime.whenRegistrationRefreshesSettled();

		await modelRuntime.refresh({ providers: ["openai-work"], allowNetwork: true });

		assert.deepEqual(modelListUrls, []);
		assert.ok((await modelRuntime.getAvailable("openai-work")).length > 0);
	});

	it("leaves an OAuth alias to its saved lists and reads no list for it (#4627)", async () => {
		const aliasAccess = "tid=alias;exp=9999999999;proxy-ep=proxy.individual.githubcopilot.com";
		stubNetwork(listsByToken({ [SOURCE_KEY]: SOURCE_LIST }));
		const modelRuntime = await aliasRuntime({
			[PROVIDER]: { type: "api_key", key: SOURCE_KEY },
			[ALIAS]: {
				type: "oauth",
				access: aliasAccess,
				refresh: "alias-refresh-token",
				expires: Number.MAX_SAFE_INTEGER,
				availableModelIds: [UNLISTED_CATALOG_MODEL_ID],
				fastModelIds: [],
			},
		});

		await modelRuntime.refresh({ providers: [PROVIDER, ALIAS], allowNetwork: true });

		assert.deepEqual(modelListAuthorizations, [`Bearer ${SOURCE_KEY}`]);
		assert.deepEqual(sorted(await aliasIds(modelRuntime)), [UNLISTED_CATALOG_MODEL_ID]);
	});
});
