import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type RequestListener } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Credential } from "@bastani/atomic-ai";
import { GITHUB_COPILOT_MODELS } from "@bastani/atomic-ai/providers/github-copilot.models";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { findInitialModel } from "../src/core/model-resolver.js";
import { ModelRuntime } from "../src/core/model-runtime.js";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { startupModelNetwork } from "../src/main-app-mode.ts";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";
import { bunExecutable, cliPath, runCliProcess } from "./cli-test-helpers.ts";

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

async function withEndpoint(run: (url: string) => Promise<void>, listener: RequestListener) {
	const server = createServer(listener);
	await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	try {
		await run(`http://127.0.0.1:${address.port}`);
	} finally {
		server.closeAllConnections();
		await new Promise<void>((done) => server.close(() => done()));
	}
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

		assert.equal(modelListRequests, 0);
		assert.equal(modelRuntime.getModel(PROVIDER, ACCOUNT_MODEL_ID), undefined);
		assert.ok((await modelRuntime.getAvailable()).some((model) => model.id === ACCOUNT_MODEL_ID));
		assert.equal(modelRuntime.getModel(PROVIDER, ACCOUNT_MODEL_ID)?.discovered, true);
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

	it("uses a credential added after restore when listing its provider (#5685)", async () => {
		serveAccountList();
		vi.stubEnv("COPILOT_GITHUB_TOKEN", "");
		const credentials = AuthStorage.inMemory();
		const runtime = await ModelRuntime.create({ credentials, modelsPath: null });
		assert.deepEqual(await runtime.getAvailable(PROVIDER), []);
		assert.equal(modelListRequests, 0);
		await credentials.modify(PROVIDER, async () => API_KEY);
		assert.ok((await runtime.getAvailable(PROVIDER)).some((model) => model.id === ACCOUNT_MODEL_ID));
		assert.equal(modelListRequests, 1);
	});

	it("does no extra store or credential lookups when the original refresh found a cached list (#5685)", async () => {
		const calls = async (allowModelNetwork?: boolean) => {
			const credentials = AuthStorage.inMemory({ openrouter: { type: "api_key", key: "fixture" } });
			const read = vi.spyOn(credentials, "read");
			const peek = vi.spyOn(credentials, "peek");
			const cache = vi.fn(async () => ({ models: [], checkedAt: 1 }));
			const runtime = await ModelRuntime.create({
				credentials,
				modelsPath: null,
				allowModelNetwork,
				modelsStore: { read: cache, write: async () => {}, delete: async () => {} },
			});
			for (let i = 0; i < 3; i++) await runtime.getAvailable("openrouter");
			return [cache.mock.calls.length, read.mock.calls.length, peek.mock.calls.length];
		};
		assert.deepEqual(await calls(), await calls(false));
	});

	it("does not probe or apply a cached catalog when initial refresh was skipped (#5685)", async () => {
		const open = async (allowModelNetwork?: boolean) => {
			const credentials = AuthStorage.inMemory({ openrouter: { type: "api_key", key: "fixture" } });
			const cache = vi.fn(async () => ({ models: [], checkedAt: 1 }));
			const auth = vi.spyOn(credentials, "read");
			const runtime = await ModelRuntime.create({
				credentials,
				modelsPath: null,
				modelsStore: { read: cache, write: async () => {}, delete: async () => {} },
				refreshOnCreate: false,
				allowModelNetwork,
			});
			for (let i = 0; i < 3; i++) await runtime.getAvailable("openrouter");
			return {
				reads: cache.mock.calls.length,
				auth: auth.mock.calls.length,
				snapshotSize: runtime.getAvailableSnapshot().length,
			};
		};
		const mainPath = await open(false);
		assert.equal(mainPath.reads, 0);
		assert.deepEqual(await open(), mainPath);
	});

	it("restores cached models even when an explicit network refresh is cancelled (#5685)", async () => {
		const credentials = AuthStorage.inMemory({ [PROVIDER]: API_KEY });
		serveAccountList();
		const options = { ...runtimePaths(), credentials, allowModelNetwork: true };
		await ModelRuntime.create(options);
		assert.ok(storedModelIds().includes(ACCOUNT_MODEL_ID));
		const explicitOptions = { ...options, signal: AbortSignal.abort() };
		const restored = await ModelRuntime.create(explicitOptions);
		assert.equal(restored.getModel(PROVIDER, ACCOUNT_MODEL_ID)?.id, ACCOUNT_MODEL_ID);
		assert.equal(modelListRequests, 2); // Explicit create-time refresh is governed by its existing deadline.
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

	it.each(["deadline", "abort"])("a skipped restore never waits for a stalled store on %s (#5685)", async (end) => {
		const controller = new AbortController();
		const held = Promise.withResolvers<undefined>();
		let probes = 0;
		const modelRuntime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory({ [PROVIDER]: API_KEY }),
			modelsPath: null,
			modelsStore: {
				read: () => {
					probes++;
					return held.promise;
				},
				write: async () => {},
				delete: async () => {},
			},
			refreshOnCreate: false,
			modelRefreshTimeoutMs: end === "deadline" ? 25.5 : 10_000,
		});
		const fetchSpy = blockNetwork();
		const listing = modelRuntime.getAvailable(PROVIDER, { signal: controller.signal }).then(
			(models) => models.some((model) => model.id === CATALOG_MODEL_ID),
			() => "aborted",
		);
		if (end === "abort") controller.abort();
		try {
			assert.equal(
				await Promise.race([listing, new Promise((resolve) => setTimeout(() => resolve("pending"), 500))]),
				end === "deadline" ? true : "aborted",
			);
		} finally {
			held.resolve(undefined);
		}
		await listing;
		assert.ok((await modelRuntime.getAvailable(PROVIDER)).some((model) => model.id === CATALOG_MODEL_ID));
		assert.equal(probes, 0);
		assert.equal(fetchSpy.mock.calls.length, 0);
	});

	it("stops reading a list that never arrives at the model refresh deadline (#5685)", async () => {
		saveCredential(API_KEY);
		const requestSignals: Array<AbortSignal | undefined> = [];
		stubNetwork((signal) => {
			requestSignals.push(signal);
			return hangUntilAborted(signal);
		});

		const started = Date.now();
		const modelRuntime = await ModelRuntime.create({
			...runtimePaths(),
			modelRefreshTimeoutMs: READ_DEADLINE_MS + 0.5,
		});
		await modelRuntime.getAvailable(PROVIDER);

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
		const modelRuntime = await ModelRuntime.create(runtimePaths());
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
		// Hold the five public catalog replies until every reader has observed the miss. They all use the same account endpoint.
		const allReading = Promise.withResolvers<void>();
		let catalogs = 0;
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const req = input instanceof Request ? input : new Request(input, init);
			if (req.url.endsWith("/api.json")) {
				if (++catalogs === 5) allReading.resolve();
				await allReading.promise;
				return new Response(null, { status: 404 });
			}
			assert.ok(req.url.endsWith("/models"));
			modelListRequests++;
			return Response.json(ACCOUNT_LIST);
		});
		const readers = await Promise.all(
			[0, 1, 2, 3, 4].map((i) =>
				ModelRuntime.create({ ...runtimePaths(), catalogBaseUrl: `https://example.test/catalog/${i}` }),
			),
		);
		const [runtimes, sessions] = await Promise.all([
			Promise.all(
				readers.slice(0, 3).map(async (runtime) => {
					await runtime.getAvailable(PROVIDER);
					return runtime;
				}),
			),
			Promise.all(readers.slice(3).map((runtime) => startSession(ACCOUNT_MODEL_ID, runtime))),
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

	it.each([false, true])(
		"another runtime restores the row visible during a refresh (explicit: %s) (#5685)",
		async (explicit) => {
			saveCredential(API_KEY);
			const started = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			stubNetwork(async () => {
				started.resolve();
				await release.promise;
				return Response.json(ACCOUNT_LIST);
			});
			const owner = await ModelRuntime.create(runtimePaths());
			const read = explicit ? owner.refresh({ providers: [PROVIDER] }) : owner.getAvailable(PROVIDER);
			await started.promise;
			try {
				const peer = await ModelRuntime.create(runtimePaths());
				assert.equal(
					(await peer.getAvailable(PROVIDER)).some((m) => m.id === ACCOUNT_MODEL_ID),
					false,
				);
				assert.equal(modelListRequests, 1);
			} finally {
				release.resolve();
				await read;
			}
			assert.ok(storedModelIds().includes(ACCOUNT_MODEL_ID));
			assert.equal(
				(await ModelRuntime.create(runtimePaths())).getModel(PROVIDER, ACCOUNT_MODEL_ID)?.id,
				ACCOUNT_MODEL_ID,
			);
		},
	);

	it("reads the list once per runtime with an in-memory models store (#5685)", async () => {
		serveAccountList();
		const credentials = () => AuthStorage.inMemory({ [PROVIDER]: API_KEY });

		const first = await ModelRuntime.create({ credentials: credentials(), modelsPath: null });
		await first.getAvailable();
		await first.getAvailable(PROVIDER);
		assert.equal(modelListRequests, 1);
		assert.equal(first.getModel(PROVIDER, ACCOUNT_MODEL_ID)?.id, ACCOUNT_MODEL_ID);

		const second = await ModelRuntime.create({ credentials: credentials(), modelsPath: null });
		await second.getAvailable(PROVIDER);
		assert.equal(modelListRequests, 2);
		assert.equal(second.getModel(PROVIDER, ACCOUNT_MODEL_ID)?.id, ACCOUNT_MODEL_ID);
	});

	it("does not give a different account a previous reader's hint for a cached list (#5685)", async () => {
		serveAccountList();
		const open = (key: string) =>
			ModelRuntime.create({
				...runtimePaths(),
				credentials: AuthStorage.inMemory({ [PROVIDER]: { type: "api_key", key } }),
			});
		await (await open("github_pat_fixture_A")).getAvailable(PROVIDER);
		writeFileSync(join(agentDir, "models-store.json"), JSON.stringify({ [PROVIDER]: { models: [], checkedAt: 1 } }));
		const modelRuntime = await open("github_pat_fixture_B");
		assertMentions(
			(
				await findInitialModel({
					scopedModels: [],
					isContinuing: false,
					defaultProvider: PROVIDER,
					defaultModelId: ACCOUNT_MODEL_ID,
					modelRuntime,
				})
			).fallbackMessage,
			"update --models",
		);
		assert.equal(modelListRequests, 1);
	});

	it("reads and lists each concurrent OpenRouter key's own models (#5685)", async () => {
		const ids = ["openai/gpt-4o", "openai/gpt-4o-mini"];
		const requests: string[] = [];
		await withEndpoint(
			async (url) => {
				writeFileSync(runtimePaths().modelsPath, JSON.stringify({ providers: { openrouter: { baseUrl: url } } }));
				const runtimes = await Promise.all(
					ids.map((_, i) =>
						ModelRuntime.create({
							...runtimePaths(),
							catalogBaseUrl: url,
							credentials: AuthStorage.inMemory({ openrouter: { type: "api_key", key: `fixture-${i}` } }),
						}),
					),
				);
				await Promise.all(
					runtimes.map(async (runtime, i) =>
						assert.deepEqual(
							(await runtime.getAvailable("openrouter")).map((m) => m.id),
							[ids[i]],
						),
					),
				);
				assert.deepEqual(requests.sort(), ["Bearer fixture-0", "Bearer fixture-1"]);
			},
			(req, res) => {
				if (req.url !== "/models/user") {
					res.writeHead(404).end();
					return;
				}
				const auth = req.headers.authorization ?? "";
				requests.push(auth);
				res.end(JSON.stringify({ data: [{ id: ids[auth.endsWith("0") ? 0 : 1] }] }));
			},
		);
	});

	it("joins a forced refresh instead of superseding it on a missing-list lookup (#5685)", async () => {
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let requests = 0;
		await withEndpoint(
			async (url) => {
				writeFileSync(runtimePaths().modelsPath, JSON.stringify({ providers: { openrouter: { baseUrl: url } } }));
				const runtime = await ModelRuntime.create({
					...runtimePaths(),
					catalogBaseUrl: url,
					credentials: AuthStorage.inMemory({ openrouter: { type: "api_key", key: "fixture" } }),
				});
				const explicit = runtime.refresh({ providers: ["openrouter"], allowNetwork: true, force: true });
				await started.promise;
				const list = runtime.getAvailable("openrouter");
				release.resolve();
				const [result, models] = await Promise.all([explicit, list]);
				assert.equal(result.errors.size, 0);
				assert.equal(requests, 1);
				assert.equal(models.find((m) => m.id === "openai/gpt-4o")?.contextWindow, 10987);
			},
			(req, res) => {
				if (req.url !== "/models/user") {
					res.writeHead(404).end();
					return;
				}
				if (++requests > 1) {
					res.writeHead(401).end();
					return;
				}
				started.resolve();
				void release.promise.then(() =>
					res.end(JSON.stringify({ data: [{ id: "openai/gpt-4o", context_length: 10987 }] })),
				);
			},
		);
	});

	it("keeps a populated list across key changes until an explicit refresh (#5685)", async () => {
		const ids = ["openai/gpt-4o", "openai/gpt-4o-mini"];
		await withEndpoint(
			async (url) => {
				writeFileSync(runtimePaths().modelsPath, JSON.stringify({ providers: { openrouter: { baseUrl: url } } }));
				const runtime = await ModelRuntime.create({
					...runtimePaths(),
					credentials: AuthStorage.inMemory(),
					catalogBaseUrl: url,
				});
				for (const index of [0, 1, 0]) {
					await runtime.setRuntimeApiKey("openrouter", `fixture-${index}`, {});
					assert.deepEqual(
						(await runtime.getAvailable("openrouter")).map((m) => m.id),
						[ids[0]],
					);
				}
			},
			(req, res) => {
				if (req.url === "/models/user")
					res.end(JSON.stringify({ data: [{ id: ids[req.headers.authorization?.endsWith("1") ? 1 : 0] }] }));
				else res.writeHead(404).end();
			},
		);
	});

	it("does not carry account advice across a replacement of the original reader's row (#5685)", async () => {
		serveAccountList();
		const runtime = await ModelRuntime.create({
			...runtimePaths(),
			credentials: AuthStorage.inMemory({ [PROVIDER]: API_KEY }),
		});
		await runtime.refresh({ providers: [PROVIDER] });
		assert.ok(runtime.getModel(PROVIDER, ACCOUNT_MODEL_ID));
		writeFileSync(join(agentDir, "models-store.json"), JSON.stringify({ [PROVIDER]: { models: [], checkedAt: 1 } }));
		const { session, modelFallbackMessage } = await startSession(ACCOUNT_MODEL_ID, runtime);
		session.dispose();
		assertMentions(modelFallbackMessage, "update --models");
	});

	it("returns the selected SDK model while an unrelated provider's restore is held (#5685)", async () => {
		serveAccountList();
		const held = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		const modelRuntime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory({ [PROVIDER]: API_KEY }),
			modelsPath: null,
			modelRefreshTimeoutMs: 1_000,
		});
		const settingsManager = SettingsManager.inMemory({ defaultProvider: PROVIDER, defaultModel: ACCOUNT_MODEL_ID });
		const resourceLoader = new DefaultResourceLoader({
			cwd: agentDir,
			agentDir,
			settingsManager,
			noExtensions: true,
			extensionFactories: [
				(pi) =>
					pi.registerProvider("fixture-held", {
						apiKey: "fixture",
						baseUrl: "http://127.0.0.1",
						api: "openai-completions",
						models: [{ ...modelRuntime.getModels(PROVIDER)[0]!, id: "fixture-static" }],
						refreshModels: async () => {
							entered.resolve();
							await held.promise;
							return [];
						},
					}),
			],
		});
		await resourceLoader.reload();
		const work = createAgentSession({
			cwd: agentDir,
			agentDir,
			modelRuntime,
			settingsManager,
			resourceLoader,
			sessionManager: SessionManager.inMemory(agentDir),
			builtins: NO_BUILTINS,
		});
		try {
			await entered.promise;
			const id = await Promise.race([
				work.then(({ session }) => session.model?.id),
				new Promise((resolve) => setTimeout(() => resolve("still waiting"), PROMPT_FALLBACK_MS)),
			]);
			assert.equal(id, ACCOUNT_MODEL_ID);
		} finally {
			held.resolve();
			(await work).session.dispose();
		}
	});

	it("starts a session on its cached provider without waiting for another account's missing list (#5685)", async () => {
		const credentials = AuthStorage.inMemory({
			[PROVIDER]: API_KEY,
			openrouter: { type: "api_key", key: "fixture" },
		});
		writeFileSync(join(agentDir, "models-store.json"), JSON.stringify({ [PROVIDER]: { models: [], checkedAt: 1 } }));
		const network = blockNetwork();
		const runtime = await ModelRuntime.create({ ...runtimePaths(), credentials, refreshOnCreate: false });
		const { session } = await startSession(CATALOG_MODEL_ID, runtime);
		session.dispose();
		assert.equal(session.model?.id, CATALOG_MODEL_ID);
		assert.equal(network.mock.calls.length, 0);
	});

	it("does not inspect another provider's credentials during scoped discovery (#5685)", async () => {
		const credentials = AuthStorage.inMemory({ openrouter: { type: "api_key", key: "fixture" } });
		const runtime = await ModelRuntime.create({ modelsPath: null, credentials, refreshOnCreate: false });
		blockNetwork();
		const peek = vi.spyOn(credentials, "peek");
		await runtime.getAvailable("openrouter");
		assert.ok(peek.mock.calls.every(([provider]) => provider === "openrouter"));
	});

	it("cancelling the missing-list wait does not cancel the shared public catalog refresh (#5685)", async () => {
		const started = Promise.withResolvers<void>();
		const reply = Promise.withResolvers<void>();
		let requests = 0;
		await withEndpoint(
			async (url) => {
				const runtime = await ModelRuntime.create({
					modelsPath: null,
					credentials: AuthStorage.inMemory({ [PROVIDER]: API_KEY }),
					catalogBaseUrl: url,
				});
				const controller = new AbortController();
				const result = runtime.getAvailable(PROVIDER, { signal: controller.signal }).catch(() => undefined);
				await started.promise;
				controller.abort();
				await result;
				reply.resolve();
				await vi.waitFor(() => assert.equal(requests, 2));
			},
			(_req, res) => {
				requests++;
				started.resolve();
				void reply.promise.then(() => res.writeHead(requests === 1 ? 503 : 404).end());
			},
		);
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

		await modelRuntime.getAvailable(PROVIDER);
		const readByThisKey = await defaultModel();
		assertMentions(readByThisKey.fallbackMessage, "update --models");

		await modelRuntime.saveCredential(
			PROVIDER,
			{ type: "api_key", key: "github_pat_other_token" },
			{ refreshCatalog: false },
		);
		const afterSwitch = await defaultModel();
		assertMentions(afterSwitch.fallbackMessage, "update --models");
	});

	it("a fresh process restores a cached row without executing a key command or giving account advice (#5685)", async () => {
		serveAccountList();
		const credentials = AuthStorage.inMemory({ [PROVIDER]: API_KEY });
		await (await ModelRuntime.create({ ...runtimePaths(), credentials })).getAvailable(PROVIDER);
		vi.stubEnv("COPILOT_GITHUB_TOKEN", "");
		writeFileSync(
			runtimePaths().modelsPath,
			JSON.stringify({
				providers: {
					[PROVIDER]: {
						apiKey: `!node -e "require('node:fs').appendFileSync('helper-runs','x');process.stdout.write('fixture')"`,
					},
				},
			}),
		);
		const normal = await ModelRuntime.create({
			...runtimePaths(),
			credentials: AuthStorage.inMemory(),
			allowModelNetwork: false,
		});
		const expected = (await normal.getAvailable(PROVIDER)).map((m) => m.id).sort();
		assert.ok(expected.includes(ACCOUNT_MODEL_ID));
		const fixture = fileURLToPath(new URL("./fixtures/model-list-command-cache.ts", import.meta.url));
		const { stdout } = await promisify(execFile)(
			bunExecutable(),
			["--no-env-file", fixture, runtimePaths().modelsPath],
			{
				cwd: agentDir,
				env: { ...process.env, HOME: agentDir, ATOMIC_CODING_AGENT_DIR: agentDir, COPILOT_GITHUB_TOKEN: "" },
			},
		);
		const result = JSON.parse(stdout);
		assert.equal(existsSync(join(agentDir, "helper-runs")), false);
		assert.equal(result.requests, 0);
		assert.deepEqual(result.ids, expected);
		assertMentions(result.fallbackMessage, "update --models");
	});

	it("a stalled restore does not retain completed responses from other accounts (#5685)", async () => {
		const fixture = fileURLToPath(new URL("./fixtures/model-list-account-retention.ts", import.meta.url));
		const { stdout } = await promisify(execFile)(bunExecutable(), ["--no-env-file", fixture], {
			env: { ...process.env, HOME: agentDir, ATOMIC_CODING_AGENT_DIR: agentDir },
		});
		assert.deepEqual(JSON.parse(stdout), { decoded: 8, retained: 0 });
	});

	it("releases file-store bookkeeping when the last runtime is collected (#5685)", async () => {
		const fixture = fileURLToPath(new URL("./fixtures/model-list-path-retention.ts", import.meta.url));
		const { stdout } = await promisify(execFile)(bunExecutable(), ["--no-env-file", fixture, agentDir], {
			env: { ...process.env, HOME: agentDir, ATOMIC_CODING_AGENT_DIR: agentDir },
		});
		assert.equal(stdout.trim(), "0");
	});

	it.each(["reselected", "qualified"])(
		"uses the inline key with the %s account model in --models (#5685)",
		async (scope) => {
			const posted: Array<[string | undefined, string | undefined]> = [];
			await withEndpoint(
				async (url) => {
					const reselect = scope === "reselected";
					if (reselect)
						writeFileSync(
							join(agentDir, "models-store.json"),
							JSON.stringify({ [PROVIDER]: { models: [], checkedAt: 1 } }),
						);
					writeFileSync(
						runtimePaths().modelsPath,
						JSON.stringify({ providers: { openrouter: { baseUrl: url } } }),
					);
					const selected = reselect ? "gpt-6.1-sol" : ACCOUNT_MODEL_ID;
					const models = `${reselect ? "openrouter/openai/gpt-4o-mini," : ""}${PROVIDER}/${selected}`;
					await runCliProcess(
						[
							"--no-session",
							"--no-extensions",
							"--print",
							"--models",
							models,
							"--api-key",
							"github_pat_inline_fixture",
							"hello",
						],
						{
							cwd: agentDir,
							env: {
								...process.env,
								HOME: agentDir,
								ATOMIC_CODING_AGENT_DIR: agentDir,
								ATOMIC_MODEL_CATALOG_URL: url,
								OPENROUTER_API_KEY: "fixture",
								GITHUB_COPILOT_BASE_URL: `${url}/copilot`,
								COPILOT_GITHUB_TOKEN: "github_pat_stored_fixture",
							},
						},
					);
					assert.deepEqual(posted, [[selected, "Bearer github_pat_inline_fixture"]]);
				},
				async (req, res) => {
					if (req.method === "POST") {
						const chunks = [];
						for await (const chunk of req) chunks.push(chunk);
						posted.push([JSON.parse(Buffer.concat(chunks).toString()).model, req.headers.authorization]);
						res.writeHead(400).end(JSON.stringify({ error: { message: "fixture received request" } }));
					} else if (req.url === "/models/user") res.end(JSON.stringify({ data: [{ id: "openai/gpt-4o" }] }));
					else if (req.url === "/copilot/models") res.end(JSON.stringify(ACCOUNT_LIST));
					else res.writeHead(404).end();
				},
			);
		},
	);

	it("an unresolved --model never applies --api-key to the saved default provider (#5685)", async () => {
		const paths: string[] = [];
		await withEndpoint(
			async (url) => {
				writeFileSync(
					join(agentDir, "settings.json"),
					JSON.stringify({ defaultProvider: "openrouter", defaultModel: "openai/gpt-4o" }),
				);
				writeFileSync(runtimePaths().modelsPath, JSON.stringify({ providers: { openrouter: { baseUrl: url } } }));
				const result = await runCliProcess(
					[
						"--no-session",
						"--no-extensions",
						"--print",
						"--model",
						"unmatched-fixture-id",
						"--api-key",
						"fixture-second",
						"hello",
					],
					{
						cwd: agentDir,
						env: {
							...process.env,
							HOME: agentDir,
							ATOMIC_CODING_AGENT_DIR: agentDir,
							ATOMIC_OFFLINE: "0",
							ATOMIC_MODEL_CATALOG_URL: url,
							OPENROUTER_API_KEY: "fixture-first",
						},
					},
				);
				assert.equal(result.code, 1);
				assert.match(result.stderr, /--api-key requires a model/);
				assert.deepEqual(paths, []);
			},
			(req, res) => {
				paths.push(req.url!);
				res.writeHead(404).end();
			},
		);
	});

	it.each([false, true])(
		"RPC answers on the selected provider without waiting for another provider (cached: %s) (#5685)",
		async (cached) => {
			const background = Promise.withResolvers<void>();
			const held = Promise.withResolvers<void>();
			const paths: string[] = [];
			await withEndpoint(
				async (url) => {
					const selected = cached ? CATALOG_MODEL_ID : ACCOUNT_MODEL_ID;
					if (cached)
						writeFileSync(
							join(agentDir, "models-store.json"),
							JSON.stringify({ [PROVIDER]: { models: [], checkedAt: 1 } }),
						);
					writeFileSync(
						runtimePaths().modelsPath,
						JSON.stringify({ providers: { openrouter: { baseUrl: url } } }),
					);
					const client = new RpcClient({
						cliPath,
						runtimeExecutable: bunExecutable(),
						cwd: agentDir,
						args: ["--no-session", "--no-extensions", "--models", `${PROVIDER}/${selected}`],
						env: {
							HOME: agentDir,
							ATOMIC_CODING_AGENT_DIR: agentDir,
							GITHUB_COPILOT_BASE_URL: url,
							ATOMIC_MODEL_CATALOG_URL: url,
							OPENROUTER_API_KEY: "fixture",
							COPILOT_GITHUB_TOKEN: "github_pat_fixture",
							ATOMIC_OFFLINE: "0",
						},
					});
					try {
						await client.start();
						assert.equal((await client.getState()).model?.id, selected);
						await background.promise;
						await vi.waitFor(() => assert.equal(paths.filter((p) => p === "/models").length, 1));
						assert.equal(paths.filter((p) => p === "/models/user").length, 1);
					} finally {
						held.resolve();
						await client.stop();
					}
				},
				(req, res) => {
					paths.push(req.url!);
					if (req.url === "/models/user") {
						background.resolve();
						void held.promise.then(() => res.end(JSON.stringify({ data: [] })));
					} else if (req.url === "/models") res.end(JSON.stringify(ACCOUNT_LIST));
					else res.writeHead(404).end();
				},
			);
		},
	);

	it("RPC serves the selected native model while its refresh runs and exposes its live result (#5685)", async () => {
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		await withEndpoint(
			async (url) => {
				const extension = join(agentDir, "native-list.ts");
				writeFileSync(
					extension,
					`export default pi => {
				const model = id => ({ id, name: id, api: "openai-completions", provider: "fixture-native", baseUrl: ${JSON.stringify(url)}, reasoning: false, input: ["text"], contextWindow: 8192, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
				let rows = [model("static")];
				pi.registerProvider({ id: "fixture-native", name: "Fixture", getModels: () => rows, refreshModelsAuth: "credential",
					auth: { apiKey: { name: "fixture", check: async () => ({ source: "fixture", type: "api_key" }), resolve: async () => ({ auth: { apiKey: "fixture" } }) } },
					async refreshModels({allowNetwork, signal, publish}) {
						if (allowNetwork) await fetch(${JSON.stringify(`${url}/native`)}, { signal });
						await publish({update: () => { rows = allowNetwork ? [model("static"), model("live")] : [model("static")] }});
					}, stream() { throw Error("unused"); }, streamSimple() { throw Error("unused"); }
				});
			}`,
				);
				const client = new RpcClient({
					cliPath,
					runtimeExecutable: bunExecutable(),
					cwd: agentDir,
					args: ["--no-session", "--no-extensions", "--extension", extension, "--model", "fixture-native/static"],
					env: {
						HOME: agentDir,
						ATOMIC_CODING_AGENT_DIR: agentDir,
						ATOMIC_MODEL_CATALOG_URL: url,
						ATOMIC_OFFLINE: "0",
					},
				});
				try {
					await client.start();
					await started.promise;
					const state = await Promise.race([
						client.getState(),
						new Promise<undefined>((done) => setTimeout(() => done(undefined), PROMPT_FALLBACK_MS)),
					]);
					assert.equal(state?.model?.id, "static");
					release.resolve();
					await vi.waitFor(async () =>
						assert.deepEqual(
							(await client.getAvailableModels())
								.filter((m) => m.provider === "fixture-native")
								.map((m) => m.id)
								.sort(),
							["live", "static"],
						),
					);
				} finally {
					release.resolve();
					await client.stop();
				}
			},
			(req, res) => {
				if (req.url === "/native") {
					started.resolve();
					void release.promise.then(() => res.end());
				} else res.writeHead(404).end();
			},
		);
	});

	it("leaves interactive startup to its background refresh and reads missing lists in every other CLI mode (#5685)", () => {
		const session = { help: false, listModels: undefined };
		assert.equal(startupModelNetwork(session, "interactive", false), false);
		assert.equal(startupModelNetwork(session, "rpc", true), false);
		for (const appMode of ["print", "json", "rpc"] as const)
			assert.equal(startupModelNetwork(session, appMode, false), undefined, appMode);
		assert.equal(startupModelNetwork({ help: false, listModels: true }, "interactive", false), undefined);
		assert.equal(startupModelNetwork({ help: true, listModels: undefined }, "print", false), false);
	});

	it("uses normal refresh advice when the refreshed account list lacks the model (#5685)", async () => {
		saveCredential(API_KEY);
		serveAccountList();

		const { session, modelFallbackMessage, modelFallbackReason } = await startSession("example-unlisted-model");
		session.dispose();

		assert.equal(modelListRequests, 1);
		assert.equal(modelFallbackReason, "configured-provider-unsupported");
		assertMentions(modelFallbackMessage, `${PROVIDER}/example-unlisted-model`);
		assertMentions(modelFallbackMessage, "update --models");
	});
});
