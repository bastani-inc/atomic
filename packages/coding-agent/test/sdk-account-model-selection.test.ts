import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelsStoreEntry } from "@bastani/atomic-ai";
import { afterEach, beforeEach, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRuntime } from "../src/core/model-runtime.js";
import { createAgentSession } from "../src/core/sdk.js";
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
function start(modelRuntime: ModelRuntime, signal?: AbortSignal) {
	return createAgentSession({
		agentDir: cwd,
		cwd,
		modelRuntime,
		builtins,
		signal,
		sessionManager: SessionManager.inMemory(cwd),
		settingsManager: SettingsManager.inMemory({ defaultProvider: provider, defaultModel: id }),
	});
}

it("selects a missing account model for the requesting SDK session, not the shared catalog (#5685)", async () => {
	const requests: string[] = [];
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const request = new Request(input, init);
		requests.push(request.url);
		return request.url.endsWith("/account/models") ? Response.json(accountList) : new Response(null, { status: 404 });
	});
	const modelRuntime = await runtime();
	const { session, modelFallbackMessage } = await start(modelRuntime);
	try {
		assert.equal(session.model?.id, id, modelFallbackMessage);
		assert.equal(session.model.api, "openai-completions");
		assert.equal(session.model.baseUrl, "http://127.0.0.1:9/account");
		assert.equal(session.model.contextWindow, 32_000);
	} finally {
		await session.dispose();
	}
	assert.deepEqual(requests, ["http://127.0.0.1:9/account/models"]);
	assert.equal(modelRuntime.getModel(provider, id), undefined);
	assert.equal((await runtime()).getModel(provider, id), undefined);
	assert.equal(await readFile(join(cwd, "auth.json"), "utf8"), storedLogin);
	await assert.rejects(readFile(join(cwd, "models-store.json")), { code: "ENOENT" });
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
	vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ data: rows }));
	const modelRuntime = await runtime();
	const { session } = await start(modelRuntime);
	try {
		assert.equal(session.model?.id, id);
	} finally {
		await session.dispose();
	}
	Object.assign(rows[0]!, { policy: { state: "disabled" } });
	const disabled = await start(modelRuntime);
	try {
		assert.notEqual(disabled.session.model?.id, id);
		assert.match(disabled.modelFallbackMessage ?? "", /does not offer/);
	} finally {
		await disabled.session.dispose();
	}
});

it("discards a response if its runtime account changed during the last credential read (#5685)", async () => {
	const auth = AuthStorage.inMemory({ [provider]: { type: "api_key", key: "github_pat_example" } });
	const started = Promise.withResolvers<void>();
	const resume = Promise.withResolvers<void>();
	let received = false;
	let held = false;
	vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
		received = true;
		return Response.json(accountList);
	});
	const modelRuntime = await ModelRuntime.create({
		modelsPath: join(cwd, "models.json"),
		credentials: {
			list: auth.list.bind(auth),
			delete: auth.delete.bind(auth),
			modify: auth.modify.bind(auth),
			async read(p, options) {
				const result = await auth.read(p, options);
				if (p === provider && received && !held) {
					held = true;
					started.resolve();
					await resume.promise;
				}
				return result;
			},
		},
	});
	const creating = start(modelRuntime);
	try {
		await Promise.race([creating, started.promise]);
		assert.equal(held, true);
		await modelRuntime.setRuntimeApiKey(provider, "github_pat_replacement", {});
		resume.resolve();
		assert.notEqual((await creating).session.model?.id, id);
	} finally {
		resume.resolve();
		await (await creating).session.dispose();
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
		const { modelFallbackMessage } = await creating;
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
	vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(accountList));
	const { session } = await start(await runtime());
	try {
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
		if (!request.url.endsWith("/account/models")) return new Response(null, { status: 404 });
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
	const sessions = [start(modelRuntime, first.signal)];
	try {
		await Promise.race([entered[0]!.promise, sessions[0]!]);
		assert.equal(signals.length, 1);
		sessions.push(start(modelRuntime, second.signal));
		await Promise.race([entered[1]!.promise, sessions[1]!]);
		assert.equal(signals.length, 2);
		first.abort();
		const cancelled = await sessions[0]!;
		assert.match(cancelled.modelFallbackMessage ?? "", /update --models/);
		assert.equal(signals[0]!.aborted, true);
		assert.equal(signals[1]!.aborted, false);
		release.resolve();
		assert.equal((await sessions[1]!).session.model?.id, id);
	} finally {
		first.abort();
		second.abort();
		release.resolve();
		for (const pending of sessions) await (await pending).session.dispose();
	}
});
