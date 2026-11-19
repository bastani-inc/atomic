import assert from "node:assert/strict";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelsStoreEntry } from "@bastani/atomic-ai";
import { afterEach, beforeEach, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRuntime } from "../src/core/model-runtime.js";
import { DefaultResourceLoader } from "../src/core/resource-loader.js";
import { type CreateAgentSessionOptions, createAgentSession } from "../src/core/sdk.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";

const provider = "github-copilot";
const id = "account-chat";
const accountList = {
	data: [
		{
			id,
			supported_endpoints: ["/chat/completions"],
			capabilities: { type: "chat", supports: { tool_calls: true }, limits: { max_context_window_tokens: 32_000 } },
		},
	],
};
const builtins = { workflows: false, subagents: false, mcp: false, "web-access": false, intercom: false } as const;
let cwd: string;
const storedLogin = JSON.stringify({ [provider]: { type: "api_key", key: "github_pat_example" } });

beforeEach(async () => {
	cwd = await mkdtemp(join(tmpdir(), "atomic-sdk-selection-"));
	vi.stubEnv("ATOMIC_OFFLINE", "0");
	await writeFile(join(cwd, "auth.json"), storedLogin);
	await writeFile(
		join(cwd, "models.json"),
		JSON.stringify({ providers: { [provider]: { baseUrl: "http://127.0.0.1:9/account" } } }),
	);
});
afterEach(async () => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	await rm(cwd, { force: true, recursive: true });
});
function runtime(modelRefreshTimeoutMs?: number) {
	return ModelRuntime.create({
		authPath: join(cwd, "auth.json"),
		modelsPath: join(cwd, "models.json"),
		catalogBaseUrl: "http://127.0.0.1:9/catalog",
		modelRefreshTimeoutMs,
	});
}
function chatResponse() {
	return new Response(
		'data: {"id":"reply","choices":[{"index":0,"delta":{"content":"fixture-ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
		{ headers: { "content-type": "text/event-stream" } },
	);
}
function start(modelRuntime: ModelRuntime, signal?: AbortSignal, options?: Partial<CreateAgentSessionOptions>) {
	return createAgentSession({
		agentDir: cwd,
		cwd,
		modelRuntime,
		builtins,
		signal,
		sessionManager: SessionManager.inMemory(cwd),
		settingsManager: SettingsManager.inMemory({ defaultProvider: provider, defaultModel: id }),
		...options,
	});
}

it("selects a missing account model for the requesting SDK session, not the shared catalog (#5685)", async () => {
	const requests: string[] = [];
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const request = new Request(input, init);
		requests.push(request.url);
		if (request.url.endsWith("/account/models")) return Response.json(accountList);
		assert.equal((await request.json()).model, id);
		return chatResponse();
	});
	const modelRuntime = await runtime();
	const { session, modelFallbackMessage } = Object.freeze(await start(modelRuntime));
	try {
		assert.deepEqual(requests, [], "the account list belongs to the first prompt, not session construction");
		assert.match(modelFallbackMessage ?? "", /update --models/);
		await session.prompt("hello");
		assert.equal(session.model?.id, id);
		assert.equal(session.model.api, "openai-completions");
		assert.equal(session.model.baseUrl, "http://127.0.0.1:9/account");
		assert.equal(session.model.contextWindow, 32_000);
		const answer = session.messages.findLast((message) => message.role === "assistant");
		assert.equal(answer?.role === "assistant" ? answer.stopReason : undefined, "stop");
	} finally {
		await session.dispose();
	}
	assert.deepEqual(requests, ["http://127.0.0.1:9/account/models", "http://127.0.0.1:9/account/chat/completions"]);
	assert.equal(modelRuntime.getModel(provider, id), undefined);
	assert.equal((await runtime()).getModel(provider, id), undefined);
	assert.equal(await readFile(join(cwd, "auth.json"), "utf8"), storedLogin);
	await assert.rejects(readFile(join(cwd, "models-store.json")), { code: "ENOENT" });
});

it("uses its own cache observation through an async runtime decorator without reading its diagnostics (#5685)", async () => {
	const modelRuntime = await runtime();
	const refresh = modelRuntime.refresh.bind(modelRuntime);
	vi.spyOn(modelRuntime, "refresh").mockImplementation(async (options) => {
		await Promise.resolve();
		return new Proxy(await refresh(options), {
			get(value, key, receiver) {
				if (key === "errors" || key === "aborted") throw new Error("refresh diagnostics are private to the host");
				return Reflect.get(value, key, receiver);
			},
		});
	});
	const requests = vi
		.spyOn(globalThis, "fetch")
		.mockImplementation(async (input, init) =>
			new Request(input, init).method === "GET" ? Response.json(accountList) : chatResponse(),
		);
	const { session } = await start(modelRuntime);
	try {
		assert.equal(requests.mock.calls.length, 0);
		await session.prompt("hello");
		assert.equal(session.model?.id, id);
		assert.equal(requests.mock.calls.length, 2);
	} finally {
		await session.dispose();
	}
});

it.each(["preset", "fallback"] as const)(
	"a usable %s handles the first prompt without an account lookup (#5685)",
	async (choice) => {
		const modelRuntime = await runtime();
		const local = modelRuntime.getModel(provider, "gemini-3.8-flash");
		assert.ok(local);
		const settingsManager = SettingsManager.inMemory({ defaultProvider: provider, defaultModel: id });
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir: cwd,
			settingsManager,
			noExtensions: true,
			extensionFactories:
				choice === "preset"
					? [
							(pi) =>
								pi.on("session_start", async () => {
									await pi.setModel(local);
								}),
						]
					: [],
		});
		await resourceLoader.reload();
		const methods: string[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const request = new Request(input, init);
			methods.push(request.method);
			return request.method === "GET" ? Response.json(accountList) : chatResponse();
		});
		const { session } = await start(modelRuntime, undefined, {
			settingsManager,
			resourceLoader,
			extensionBindings: { mode: "rpc" },
			fallbackModels: choice === "fallback" ? [`${provider}/${local.id}`] : undefined,
		});
		try {
			await session.prompt("hello");
			assert.equal(session.model?.id, local.id);
			assert.deepEqual(methods, ["POST"]);
		} finally {
			await session.dispose();
		}
	},
);

it("rejects invalid tools before asking for the account list (#5685)", async () => {
	const modelRuntime = await runtime();
	const requests = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(accountList));
	await assert.rejects(start(modelRuntime, undefined, { tools: ["read", "+bash"] }), /Invalid tools option/);
	assert.equal(requests.mock.calls.length, 0);
});

it("an asynchronous-only credential store keeps the local miss without a discovery read (#5685)", async () => {
	const auth = AuthStorage.inMemory({ [provider]: { type: "api_key", key: "github_pat_example" } });
	const read = vi.fn(auth.read.bind(auth));
	const modelRuntime = await ModelRuntime.create({
		modelsPath: join(cwd, "models.json"),
		credentials: { read, list: auth.list.bind(auth), delete: auth.delete.bind(auth), modify: auth.modify.bind(auth) },
	});
	const requests = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(accountList));
	const { session, modelFallbackMessage } = await start(modelRuntime);
	try {
		await modelRuntime.whenRegistrationRefreshesSettled();
		read.mockClear();
		await assert.rejects(session.prompt("hello"), { code: "no_usable_model" });
		assert.match(modelFallbackMessage ?? "", /update --models/);
		assert.equal(read.mock.calls.length, 0);
		assert.equal(requests.mock.calls.length, 0);
	} finally {
		await session.dispose();
	}
});

it("a prompt validation error is reported before an unused account lookup (#5685)", async () => {
	const requests = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(accountList));
	const modelRuntime = await runtime();
	const { session } = await start(modelRuntime);
	const diagnostic = new Error("local credential validation failed");
	vi.spyOn(modelRuntime, "hasConfiguredAuth").mockImplementation(() => {
		throw diagnostic;
	});
	try {
		await assert.rejects(session.prompt("hello"), (error) => error === diagnostic);
		assert.equal(requests.mock.calls.length, 0);
	} finally {
		await session.dispose();
	}
});

it.each(["absent", "empty", "saved"] as const)(
	"an ordinary %s Copilot cache restore reads once and preserves its local result (#5685)",
	async (row) => {
		const requests = vi
			.spyOn(globalThis, "fetch")
			.mockRejectedValue(new Error("No network during restore or listing"));
		const reads: string[] = [];
		let entry: ModelsStoreEntry | undefined;
		const modelRuntime = await ModelRuntime.create({
			refreshOnCreate: false,
			modelsPath: null,
			credentials: AuthStorage.inMemory({ [provider]: { type: "api_key", key: "github_pat_example" } }),
			modelsStore: {
				read: async (name) => {
					reads.push(name);
					return entry;
				},
				write: async () => {
					throw new Error("Unexpected cache write");
				},
				delete: async () => {
					throw new Error("Unexpected cache deletion");
				},
			},
		});
		const bundled = modelRuntime.getModels(provider);
		const saved = { ...bundled[0]!, id, name: "Saved model", discovered: true };
		entry = row === "absent" ? undefined : { checkedAt: 1, models: row === "saved" ? [saved] : [] };
		const restored = await modelRuntime.refresh({ providers: [provider], allowNetwork: false });
		assert.deepEqual(restored, { aborted: false, errors: new Map() });
		assert.deepEqual(await modelRuntime.getAvailable(provider), row === "saved" ? [...bundled, saved] : bundled);
		assert.deepEqual(reads, [provider]);
		assert.equal(requests.mock.calls.length, 0);
		if (row === "empty") {
			const { session, modelFallbackMessage } = await start(modelRuntime);
			try {
				assert.match(modelFallbackMessage ?? "", /update --models/);
				await assert.rejects(session.prompt("hello"), { code: "no_usable_model" });
				assert.equal(requests.mock.calls.length, 0);
			} finally {
				await session.dispose();
			}
		}
	},
);

it("can select an advertised exact chat ID without a picker flag but never a disabled model (#5685)", async () => {
	const rows = [
		{ ...accountList.data[0]! },
		{ ...accountList.data[0]!, id: "picker-entry", model_picker_enabled: true },
	];
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) =>
		new Request(input, init).method === "GET" ? Response.json({ data: rows }) : chatResponse(),
	);
	const modelRuntime = await runtime();
	const { session } = await start(modelRuntime);
	try {
		await session.prompt("hello");
		assert.equal(session.model?.id, id);
	} finally {
		await session.dispose();
	}
	Object.assign(rows[0]!, { policy: { state: "disabled" } });
	const disabled = Object.freeze(await start(modelRuntime));
	try {
		await assert.rejects(disabled.session.prompt("hello"), {
			name: "NoUsableModelError",
			code: "no_usable_model",
			message: /account model list does not offer account-chat/,
		});
		assert.notEqual(disabled.session.model?.id, id);
		assert.match(disabled.modelFallbackMessage ?? "", /update --models/);
	} finally {
		await disabled.session.dispose();
	}
});

it("discards a response if its runtime account changed before selection (#5685)", async () => {
	const started = Promise.withResolvers<void>();
	const resume = Promise.withResolvers<void>();
	const requests = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
		started.resolve();
		await resume.promise;
		return Response.json(accountList);
	});
	const modelRuntime = await runtime();
	const { session } = await start(modelRuntime);
	const attempt = assert.rejects(session.prompt("hello"), { code: "no_usable_model" });
	try {
		await Promise.race([attempt, started.promise]);
		assert.equal(requests.mock.calls.length, 1);
		await modelRuntime.setRuntimeApiKey(provider, "github_pat_replacement", {});
		resume.resolve();
		await attempt;
		assert.notEqual(session.model?.id, id);
		assert.equal(requests.mock.calls.length, 1);
	} finally {
		resume.resolve();
		await session.dispose();
	}
});

it("a replaced credential file invalidates only the waiting session's account response (#5685)", async () => {
	const methods: string[] = [];
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const request = new Request(input, init);
		methods.push(request.method);
		if (methods.length === 1) {
			await writeFile(join(cwd, "replacement"), storedLogin);
			await rename(join(cwd, "replacement"), join(cwd, "auth.json"));
		}
		return request.method === "GET" ? Response.json(accountList) : chatResponse();
	});
	const modelRuntime = await runtime();
	const a = await start(modelRuntime);
	try {
		await modelRuntime.whenRegistrationRefreshesSettled();
		await assert.rejects(a.session.prompt("hello"), { code: "no_usable_model" });
		assert.match(a.modelFallbackMessage ?? "", /update --models/);
		assert.deepEqual(methods, ["GET"]);
	} finally {
		await a.session.dispose();
	}
	const b = await start(modelRuntime);
	try {
		await b.session.prompt("hello");
		assert.equal(b.session.model?.id, id);
		assert.deepEqual(methods, ["GET", "GET", "POST"]);
	} finally {
		await b.session.dispose();
	}
});

it("a superseded session restore cannot claim a miss observed before it started (#5685)", async () => {
	const reads = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
	const release = Promise.withResolvers<void>();
	let warm = false;
	let count = 0;
	const modelRuntime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory({ [provider]: { type: "api_key", key: "github_pat_example" } }),
		modelsPath: null,
		modelsStore: {
			async read(p) {
				if (p !== provider || !warm) return undefined;
				reads[count++]?.resolve();
				await release.promise;
				return { models: [] };
			},
			async write() {
				throw new Error("Unexpected cache write");
			},
			async delete() {
				throw new Error("Unexpected cache deletion");
			},
		},
	});
	warm = true;
	const requests = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ data: [] }));
	const creating = start(modelRuntime);
	let newer: Promise<unknown> | undefined;
	try {
		await reads[0]!.promise;
		newer = modelRuntime.refresh({ providers: [provider], allowNetwork: false });
		await reads[1]!.promise;
		const { session, modelFallbackMessage } = await creating;
		await assert.rejects(session.prompt("hello"), { code: "no_usable_model" });
		assert.equal(requests.mock.calls.length, 0);
		assert.match(modelFallbackMessage ?? "", /update --models/);
	} finally {
		release.resolve();
		await newer;
		await (await creating).session.dispose();
	}
});

it("a cache-only runtime does not consume an unused create-time network deadline (#5685)", async () => {
	let networkPolicyReads = 0;
	await ModelRuntime.create({
		authPath: join(cwd, "auth.json"),
		modelsPath: join(cwd, "models.json"),
		get allowModelNetwork() {
			networkPolicyReads++;
			return undefined;
		},
		get modelRefreshTimeoutMs(): number {
			throw new Error("only an explicitly requested create-time network refresh needs its deadline");
		},
	});
	assert.equal(networkPolicyReads, 1);
});

it("retains both provider and model-specific request settings on an account-only model (#5685)", async () => {
	await writeFile(
		join(cwd, "models.json"),
		JSON.stringify({
			providers: {
				[provider]: {
					baseUrl: "http://127.0.0.1:9/account",
					compat: { supportsUsageInStreaming: false },
					modelOverrides: { [id]: { compat: { supportsDeveloperRole: true } } },
				},
			},
		}),
	);
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) =>
		new Request(input, init).method === "GET" ? Response.json(accountList) : chatResponse(),
	);
	const { session } = await start(await runtime());
	try {
		await session.prompt("hello");
		assert.equal(session.model?.id, id);
		assert.ok(session.model.compat && "supportsUsageInStreaming" in session.model.compat);
		assert.equal(session.model.compat.supportsUsageInStreaming, false);
		assert.equal(session.model.compat.supportsDeveloperRole, true);
	} finally {
		await session.dispose();
	}
});

it("cancelling one unresolved session leaves the other session's account request running (#5685)", async () => {
	const first = new AbortController();
	const second = new AbortController();
	const entered = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
	const release = Promise.withResolvers<void>();
	const signals: AbortSignal[] = [];
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const request = new Request(input, init);
		if (!request.url.endsWith("/account/models")) return chatResponse();
		entered[signals.length]?.resolve();
		signals.push(request.signal);
		await Promise.race([
			release.promise,
			new Promise<void>((_, reject) =>
				request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true }),
			),
		]);
		return Response.json(accountList);
	});
	const modelRuntime = await runtime(4_000);
	const a = await start(modelRuntime, first.signal);
	const b = await start(modelRuntime, second.signal);
	try {
		const cancelled = assert.rejects(a.session.prompt("hello"), { code: "no_usable_model" });
		await Promise.race([entered[0]!.promise, cancelled]);
		assert.equal(signals.length, 1);
		const other = b.session.prompt("hello");
		await Promise.race([entered[1]!.promise, other]);
		assert.equal(signals.length, 2);
		first.abort();
		await cancelled;
		assert.match(a.modelFallbackMessage ?? "", /update --models/);
		assert.equal(signals[0]!.aborted, true);
		assert.equal(signals[1]!.aborted, false);
		release.resolve();
		await other;
		assert.equal(b.session.model?.id, id);
	} finally {
		first.abort();
		second.abort();
		release.resolve();
		await Promise.all([a.session.dispose(), b.session.dispose()]);
	}
});
