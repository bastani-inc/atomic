import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Credential } from "@bastani/atomic-ai";
import { GITHUB_COPILOT_MODELS } from "@bastani/atomic-ai/providers/github-copilot.models";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { findInitialModel } from "../src/core/model-resolver.js";
import { ModelRuntime } from "../src/core/model-runtime.js";
import { createAgentSession } from "../src/core/sdk.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { startupModelNetwork } from "../src/main-app-mode.ts";

const PROVIDER = "github-copilot";
const API_KEY: Credential = { type: "api_key", key: "github_pat_example_token" };
/** A model only the account's list offers: the bundled catalog lacks it. */
const ACCOUNT_MODEL_ID = "example-account-model";
/** A real catalog model, read from the catalog so the test names no model itself. */
const CATALOG_MODEL_ID = Object.keys(GITHUB_COPILOT_MODELS)[0] ?? "";
const CATALOG_IDS = Object.keys(GITHUB_COPILOT_MODELS);
const NO_BUILTINS = { workflows: false, subagents: false, mcp: false, "web-access": false, intercom: false } as const;
/** A short read deadline, still long enough for the list request to start on a loaded machine. */
const READ_DEADLINE_MS = 1_000;
/** How long a fallback may take when the read cannot finish: well under the default 15-second deadline. */
const PROMPT_FALLBACK_MS = 5_000;

const ACCOUNT_LIST = {
	object: "list",
	data: [ACCOUNT_MODEL_ID, CATALOG_MODEL_ID].map((id) => ({
		id,
		name: `Display name of ${id}`,
		object: "model",
		vendor: "Example Vendor",
		version: id,
		preview: false,
		model_picker_enabled: true,
		policy: { state: "enabled", terms: "" },
		supported_endpoints: ["/responses"],
		capabilities: {
			family: id,
			object: "model_capabilities",
			type: "chat",
			tokenizer: "o200k_base",
			limits: { max_context_window_tokens: 400_000, max_prompt_tokens: 272_000, max_output_tokens: 64_000 },
			supports: { streaming: true, tool_calls: true, vision: true, reasoning_effort: ["low", "medium", "high"] },
		},
	})),
};

let agentDir: string;
let modelListRequests: number;

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "atomic-missing-model-list-"));
	modelListRequests = 0;
	vi.stubEnv("ATOMIC_OFFLINE", "0");
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	rmSync(agentDir, { recursive: true, force: true });
});

/** The account's `/models` list answers with `modelList`; models.dev has no catalog to add. */
function stubNetwork(modelList: (signal: AbortSignal | undefined) => Response | Promise<Response>) {
	return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const request = input instanceof Request ? input : new Request(input, init);
		if (request.url === "https://models.dev/api.json") return new Response("not found", { status: 404 });
		if (request.url.endsWith("/models")) {
			modelListRequests += 1;
			return modelList(init?.signal ?? undefined);
		}
		throw new Error(`Unexpected request: ${request.url}`);
	});
}

const serveAccountList = () => stubNetwork(() => Response.json(ACCOUNT_LIST));

function blockNetwork() {
	return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
		throw new Error(`Unexpected request: ${String(input)}`);
	});
}

/** A request that never answers; it rejects only when its signal aborts. */
function hangUntilAborted(signal: AbortSignal | undefined): Promise<Response> {
	return new Promise((_resolve, reject) => {
		signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
	});
}

function saveCredential(credential: Credential): void {
	writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ [PROVIDER]: credential }));
}

function runtimePaths() {
	return { authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") };
}

function storedModelIds(): string[] {
	const stored = JSON.parse(readFileSync(join(agentDir, "models-store.json"), "utf8")) as Record<
		string,
		{ models: Array<{ id: string }> }
	>;
	return stored[PROVIDER]?.models.map((model) => model.id) ?? [];
}

async function startSession(defaultModel: string, modelRuntime?: ModelRuntime) {
	const cwd = join(agentDir, "project");
	mkdirSync(cwd, { recursive: true });
	return createAgentSession({
		cwd,
		agentDir,
		...(modelRuntime ? { modelRuntime } : {}),
		sessionManager: SessionManager.inMemory(cwd),
		settingsManager: SettingsManager.inMemory({ defaultProvider: PROVIDER, defaultModel }),
		builtins: NO_BUILTINS,
	});
}

function assertMentions(message: string | undefined, text: string): void {
	assert.ok(message?.includes(text), `${JSON.stringify(message)} does not mention ${JSON.stringify(text)}`);
}

describe("an SDK runtime without a cached account model list (#5685)", () => {
	it("reads the list itself and starts a session on a model only that list offers (#5685)", async () => {
		saveCredential(API_KEY);
		serveAccountList();

		const { session, modelFallbackMessage } = await startSession(ACCOUNT_MODEL_ID);
		try {
			assert.equal(modelFallbackMessage, undefined);
			assert.equal(session.model?.provider, PROVIDER);
			assert.equal(session.model?.id, ACCOUNT_MODEL_ID);
		} finally {
			session.dispose();
		}
		assert.equal(modelListRequests, 1);
		// Cached like a normal refresh, so the next start needs no network.
		assert.ok(storedModelIds().includes(ACCOUNT_MODEL_ID));
	});

	it("reads the list for a supplied runtime created without its initial refresh (#5685)", async () => {
		saveCredential(API_KEY);
		serveAccountList();
		const modelRuntime = await ModelRuntime.create({ ...runtimePaths(), refreshOnCreate: false });
		assert.equal(modelListRequests, 0);

		const { session, modelFallbackMessage } = await startSession(ACCOUNT_MODEL_ID, modelRuntime);
		session.dispose();

		assert.equal(modelFallbackMessage, undefined);
		assert.equal(session.model?.id, ACCOUNT_MODEL_ID);
		assert.equal(modelListRequests, 1);
	});

	it("resolves and lists the model from ModelRuntime.create, and later runtimes reuse the cache without the network (#5685)", async () => {
		saveCredential(API_KEY);
		serveAccountList();

		const modelRuntime = await ModelRuntime.create(runtimePaths());

		assert.equal(modelRuntime.getModel(PROVIDER, ACCOUNT_MODEL_ID)?.discovered, true);
		assert.ok((await modelRuntime.getAvailable()).some((model) => model.id === ACCOUNT_MODEL_ID));
		assert.equal(modelListRequests, 1);

		vi.restoreAllMocks();
		const fetchSpy = blockNetwork();
		const restarted = await ModelRuntime.create(runtimePaths());
		assert.equal(restarted.getModel(PROVIDER, ACCOUNT_MODEL_ID)?.discovered, true);
		assert.ok((await restarted.getAvailable(PROVIDER)).some((model) => model.id === ACCOUNT_MODEL_ID));
		const { session } = await startSession(ACCOUNT_MODEL_ID, restarted);
		session.dispose();
		assert.equal(fetchSpy.mock.calls.length, 0);
	});

	it("makes no request when a list is cached, even one without the model, and keeps the refresh hint (#5685)", async () => {
		saveCredential(API_KEY);
		writeFileSync(
			join(agentDir, "models-store.json"),
			JSON.stringify({ [PROVIDER]: { models: [], checkedAt: Date.now() } }),
		);
		const fetchSpy = blockNetwork();

		const modelRuntime = await ModelRuntime.create(runtimePaths());
		await modelRuntime.getAvailable();
		const { session, modelFallbackMessage, modelFallbackReason } = await startSession(ACCOUNT_MODEL_ID, modelRuntime);
		session.dispose();

		assert.equal(fetchSpy.mock.calls.length, 0);
		assert.equal(modelFallbackReason, "configured-provider-unsupported");
		assertMentions(modelFallbackMessage, "update --models");
	});

	it.each([
		[
			"unreachable",
			(): Response => {
				throw new TypeError("fetch failed");
			},
		],
		["refused with 401", () => new Response("refused", { status: 401 })],
	])(
		"falls back to the bundled catalog and the refresh hint when the list cannot be read (%s) (#5685)",
		async (_label, failure) => {
			saveCredential(API_KEY);
			stubNetwork(failure);

			const { session, modelFallbackMessage, modelFallbackReason } = await startSession(ACCOUNT_MODEL_ID);
			const available = (await session.modelRuntime.getAvailable(PROVIDER)).map((model) => model.id);
			session.dispose();

			assert.equal(modelListRequests, 1);
			assert.equal(modelFallbackReason, "configured-provider-unsupported");
			assertMentions(modelFallbackMessage, `${PROVIDER}/${ACCOUNT_MODEL_ID}`);
			assertMentions(modelFallbackMessage, "update --models");
			// Nothing is hidden on a guess.
			for (const id of CATALOG_IDS) assert.ok(available.includes(id), id);
		},
	);

	it("stops reading a list that never arrives at the create-time deadline (#5685)", async () => {
		saveCredential(API_KEY);
		const requestSignals: Array<AbortSignal | undefined> = [];
		stubNetwork((signal) => {
			requestSignals.push(signal);
			return hangUntilAborted(signal);
		});

		const started = Date.now();
		const modelRuntime = await ModelRuntime.create({ ...runtimePaths(), modelRefreshTimeoutMs: READ_DEADLINE_MS });

		assert.ok(Date.now() - started < PROMPT_FALLBACK_MS, `create took ${Date.now() - started} ms`);
		assert.equal(modelListRequests, 1);
		assert.equal(requestSignals[0]?.aborted, true);
		assert.equal(modelRuntime.getModel(PROVIDER, ACCOUNT_MODEL_ID), undefined);
		assert.ok(modelRuntime.getModel(PROVIDER, CATALOG_MODEL_ID));
	});

	it("stops waiting, and stops the read, when the caller's signal aborts (#5685)", async () => {
		saveCredential(API_KEY);
		const requestSignals: Array<AbortSignal | undefined> = [];
		let requestStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			requestStarted = resolve;
		});
		stubNetwork((signal) => {
			requestSignals.push(signal);
			requestStarted();
			return hangUntilAborted(signal);
		});
		const modelRuntime = await ModelRuntime.create({ ...runtimePaths(), refreshOnCreate: false });
		assert.equal(modelListRequests, 0);

		const controller = new AbortController();
		const listing = modelRuntime.getAvailable(PROVIDER, { signal: controller.signal });
		await started;
		const abortedAt = Date.now();
		controller.abort();
		await listing.catch(() => undefined);

		assert.ok(Date.now() - abortedAt < PROMPT_FALLBACK_MS, `getAvailable took ${Date.now() - abortedAt} ms`);
		assert.equal(modelListRequests, 1);
		assert.equal(requestSignals[0]?.aborted, true);
	});

	it("makes no request in offline mode (#5685)", async () => {
		vi.stubEnv("ATOMIC_OFFLINE", "1");
		saveCredential(API_KEY);
		const fetchSpy = blockNetwork();

		const modelRuntime = await ModelRuntime.create(runtimePaths());
		await modelRuntime.getAvailable();

		assert.equal(fetchSpy.mock.calls.length, 0);
		assert.equal(existsSync(join(agentDir, "models-store.json")), false);
	});

	it("reads the list once for concurrent runtimes and sessions on one models store (#5685)", async () => {
		saveCredential(API_KEY);
		serveAccountList();

		const [runtimes, sessions] = await Promise.all([
			Promise.all([1, 2, 3].map(() => ModelRuntime.create(runtimePaths()))),
			Promise.all([1, 2].map(() => startSession(ACCOUNT_MODEL_ID))),
		]);

		assert.equal(modelListRequests, 1);
		for (const modelRuntime of runtimes)
			assert.equal(modelRuntime.getModel(PROVIDER, ACCOUNT_MODEL_ID)?.id, ACCOUNT_MODEL_ID);
		for (const { session, modelFallbackMessage } of sessions) {
			assert.equal(modelFallbackMessage, undefined);
			assert.equal(session.model?.id, ACCOUNT_MODEL_ID);
			session.dispose();
		}
		assert.ok(storedModelIds().includes(ACCOUNT_MODEL_ID));
	});

	it("reads the list once per runtime with an in-memory models store (#5685)", async () => {
		serveAccountList();
		const credentials = () => AuthStorage.inMemory({ [PROVIDER]: API_KEY });

		const first = await ModelRuntime.create({ credentials: credentials(), modelsPath: null });
		await first.getAvailable();
		await first.getAvailable(PROVIDER);
		assert.equal(modelListRequests, 1);
		assert.equal(first.getModel(PROVIDER, ACCOUNT_MODEL_ID)?.id, ACCOUNT_MODEL_ID);

		const second = await ModelRuntime.create({ credentials: credentials(), modelsPath: null });
		assert.equal(modelListRequests, 2);
		assert.equal(second.getModel(PROVIDER, ACCOUNT_MODEL_ID)?.id, ACCOUNT_MODEL_ID);
	});

	it("asks for a refresh again once the credential that read the list changes (#5685)", async () => {
		saveCredential(API_KEY);
		serveAccountList();
		const modelRuntime = await ModelRuntime.create(runtimePaths());
		const defaultModel = () =>
			findInitialModel({
				scopedModels: [],
				isContinuing: false,
				defaultProvider: PROVIDER,
				defaultModelId: "example-unlisted-model",
				modelRuntime,
			});

		const readByThisKey = await defaultModel();
		assertMentions(readByThisKey.fallbackMessage, "model list GitHub Copilot returned for this account");

		await modelRuntime.saveCredential(
			PROVIDER,
			{ type: "api_key", key: "github_pat_other_token" },
			{ refreshCatalog: false },
		);
		const afterSwitch = await defaultModel();
		assertMentions(afterSwitch.fallbackMessage, "update --models");
	});

	it("leaves interactive startup to its background refresh and reads missing lists in every other CLI mode (#5685)", () => {
		const session = { help: false, listModels: undefined };
		assert.equal(startupModelNetwork(session, "interactive", false), false);
		// The engine child serves an interactive host.
		assert.equal(startupModelNetwork(session, "rpc", true), false);
		for (const appMode of ["print", "json", "rpc"] as const)
			assert.equal(startupModelNetwork(session, appMode, false), undefined, appMode);
		assert.equal(startupModelNetwork({ help: false, listModels: true }, "interactive", false), undefined);
		assert.equal(startupModelNetwork({ help: true, listModels: undefined }, "print", false), false);
	});

	it("says the account's list lacks a model it just read instead of asking for a refresh (#5685)", async () => {
		saveCredential(API_KEY);
		serveAccountList();

		const { session, modelFallbackMessage, modelFallbackReason } = await startSession("example-unlisted-model");
		session.dispose();

		assert.equal(modelListRequests, 1);
		assert.equal(modelFallbackReason, "configured-provider-unsupported");
		assertMentions(modelFallbackMessage, `${PROVIDER}/example-unlisted-model`);
		assertMentions(modelFallbackMessage, "model list GitHub Copilot returned for this account");
		assert.equal(modelFallbackMessage?.includes("update --models"), false, modelFallbackMessage);
	});
});
