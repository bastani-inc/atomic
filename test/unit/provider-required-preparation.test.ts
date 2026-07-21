import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStorage } from "../../packages/coding-agent/src/core/auth-storage.js";
import { ModelRegistry } from "../../packages/coding-agent/src/core/model-registry.js";
import type { ProviderConfigInput } from "../../packages/coding-agent/src/core/model-registry-types.js";
import { registerPendingProvidersAndPrepare } from "../../packages/coding-agent/src/core/provider-preparation-lifecycle.js";
import type { ResourceLoader } from "../../packages/coding-agent/src/core/resource-loader.js";
import { CursorError } from "../../packages/cursor/src/errors.js";
import { ProviderModelSelectionError } from "../../packages/coding-agent/src/core/provider-model-reference.js";
import { prepareExplicitProvider } from "../../packages/coding-agent/src/core/model-resolver-cli.js";

const preparedModel: NonNullable<ProviderConfigInput["models"]>[number] = {
	id: "live",
	name: "Live",
	api: "openai-completions",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1,
	maxTokens: 1,
};

function requiredConfig(refreshModels: NonNullable<ProviderConfigInput["refreshModels"]>): ProviderConfigInput {
	return {
		name: "Required",
		baseUrl: "https://example.invalid",
		api: "openai-completions",
		apiKey: "test-only",
		models: [],
		requiresPreparation: true,
		refreshModels,
	};
}

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (predicate()) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	}
	throw new Error("condition not reached");
}

describe("required provider preparation doors", () => {
	test("awaits tracked preparation before publishing the authoritative catalog", async () => {
		const registry = ModelRegistry.create(AuthStorage.inMemory(), []);
		let resolveRefresh: ((models: NonNullable<ProviderConfigInput["models"]>) => void) | undefined;
		registry.registerProvider("required", requiredConfig(async () => new Promise((resolve) => { resolveRefresh = resolve; })));
		assert.deepEqual(registry.getAll().filter((model) => model.provider === "required"), []);
		let completed = false;
		const preparing = registry.prepareRequiredProviders().then(() => { completed = true; });
		await waitFor(() => resolveRefresh !== undefined);
		assert.equal(completed, false);
		resolveRefresh?.([preparedModel]);
		await preparing;
		assert.deepEqual(registry.getAll().filter((model) => model.provider === "required").map((model) => model.id), ["live"]);
	});

	test("preparing a new required provider never refreshes or clears an already-prepared generation", async () => {
		const registry = ModelRegistry.create(AuthStorage.inMemory(), []);
		let aCalls = 0;
		let bCalls = 0;
		registry.registerProvider("required-a", requiredConfig(async () => {
			aCalls += 1;
			if (aCalls > 1) throw new Error("prepared A must not refresh again");
			return [{ ...preparedModel, id: "a" }];
		}));
		await registry.prepareRequiredProviders();
		registry.registerProvider("required-b", requiredConfig(async () => {
			bCalls += 1;
			return [{ ...preparedModel, id: "b" }];
		}));
		await registry.prepareRequiredProviders();
		assert.deepEqual({ aCalls, bCalls }, { aCalls: 1, bCalls: 1 });
		assert.equal(registry.resolveExactModel("required-a", "a").id, "a");
		assert.equal(registry.resolveExactModel("required-b", "b").id, "b");
	});

	test("direct successful required refresh is recorded and not repeated by preparation", async () => {
		const registry = ModelRegistry.create(AuthStorage.inMemory(), []);
		let calls = 0;
		registry.registerProvider("required", requiredConfig(async () => { calls += 1; return [preparedModel]; }));
		await registry.refresh();
		await registry.prepareRequiredProviders();
		assert.equal(calls, 1);
	});

	test("successful siblings are recorded when another required provider fails", async () => {
		const registry = ModelRegistry.create(AuthStorage.inMemory(), []);
		let aCalls = 0;
		let bCalls = 0;
		registry.registerProvider("required-a", requiredConfig(async () => { aCalls += 1; throw new Error("A failed"); }));
		registry.registerProvider("required-b", requiredConfig(async () => { bCalls += 1; return [{ ...preparedModel, id: "b" }]; }));
		await assert.rejects(registry.prepareRequiredProviders(), /A failed/u);
		registry.registerProvider("required-a", requiredConfig(async () => { aCalls += 1; return [{ ...preparedModel, id: "a" }]; }));
		await registry.prepareRequiredProviders();
		assert.deepEqual({ aCalls, bCalls }, { aCalls: 2, bCalls: 1 });
	});

	test("failed required refresh invalidates preparation so the tracked door retries", async () => {
		const registry = ModelRegistry.create(AuthStorage.inMemory(), []);
		let calls = 0;
		let fail = false;
		registry.registerProvider("required", requiredConfig(async () => {
			calls += 1;
			if (fail) throw new Error("transient refresh failure");
			return [preparedModel];
		}));
		await registry.prepareRequiredProviders();
		fail = true;
		const failed = await registry.refresh({ allowNetwork: false });
		assert.match(failed.errors.get("required")?.message ?? "", /transient/u);
		assert.deepEqual(registry.getAll().filter((model) => model.provider === "required"), []);
		fail = false;
		await registry.prepareRequiredProviders();
		assert.equal(calls, 3);
		assert.equal(registry.resolveExactModel("required", "live").id, "live");
	});

	test("rejected re-registration preserves the prepared provider generation", async () => {
		const registry = ModelRegistry.create(AuthStorage.inMemory(), []);
		let calls = 0;
		registry.registerProvider("required", requiredConfig(async () => { calls += 1; return [preparedModel]; }));
		await registry.prepareRequiredProviders();
		assert.throws(() => registry.registerProvider("required", {
			name: "Invalid replacement", models: [], streamSimple: (() => undefined) as never,
		}), /api/u);
		await registry.prepareRequiredProviders();
		assert.equal(calls, 1);
		assert.equal(registry.resolveExactModel("required", "live").id, "live");
	});

	test("published required generation stays current for post-publish authority checks", async () => {
		const registry = ModelRegistry.create(AuthStorage.inMemory(), []);
		let captured: (() => boolean) | undefined;
		registry.registerProvider("required", requiredConfig(async ({ isCurrentGeneration }) => {
			captured = isCurrentGeneration;
			return [preparedModel];
		}));
		await registry.prepareRequiredProviders();
		assert.equal(registry.resolveExactModel("required", "live").id, "live");
		assert.equal(captured?.(), true);
	});

	test("a skipped unauthenticated required refresh is not marked prepared and runs after late runtime auth", async () => {
		const auth = AuthStorage.inMemory();
		const registry = ModelRegistry.create(auth, []);
		let calls = 0;
		const config = requiredConfig(async () => { calls += 1; return [preparedModel]; });
		delete config.apiKey;
		registry.registerProvider("required", config);
		await registry.prepareRequiredProviders();
		assert.equal(calls, 0);
		assert.deepEqual(registry.getAll().filter((model) => model.provider === "required"), []);
		auth.setRuntimeApiKey("required", "late-runtime-key");
		await registry.prepareRequiredProviders();
		assert.equal(calls, 1);
		assert.equal(registry.resolveExactModel("required", "live").id, "live");
	});

	test("explicit preparation runs for requiresPreparation providers without exact-selection persistence", async () => {
		const registry = ModelRegistry.create(AuthStorage.inMemory(), []);
		let calls = 0;
		registry.registerProvider("required-plain", requiredConfig(async () => { calls += 1; return [preparedModel]; }));
		assert.equal(registry.requiresProviderPreparation("required-plain"), true);
		await prepareExplicitProvider("required-plain", registry);
		assert.equal(calls, 1);
		assert.equal(registry.resolveExactModel("required-plain", "live").id, "live");
	});

	test("required provider hides pre-existing static rows during pending refresh even when models is omitted", async () => {
		const dir = mkdtempSync(join(tmpdir(), "atomic-required-omitted-"));
		try {
			const path = join(dir, "models.json");
			writeFileSync(path, JSON.stringify({ providers: { required: {
				baseUrl: "https://static.invalid", apiKey: "static-key", api: "openai-completions",
				models: [{ ...preparedModel, id: "static" }],
			} } }));
			const registry = ModelRegistry.create(AuthStorage.inMemory(), path);
			assert.equal(registry.find("required", "static")?.id, "static");
			let resolveRefresh: ((models: NonNullable<ProviderConfigInput["models"]>) => void) | undefined;
			const overlay = requiredConfig(() => new Promise((resolve) => { resolveRefresh = resolve; }));
			delete overlay.models;
			registry.registerProvider("required", overlay);
			const refreshing = registry.refresh();
			await waitFor(() => resolveRefresh !== undefined);
			assert.deepEqual(registry.getAll().filter((model) => model.provider === "required"), []);
			resolveRefresh?.([preparedModel]);
			await refreshing;
			assert.equal(registry.find("required", "static"), undefined);
			assert.equal(registry.resolveExactModel("required", "live").id, "live");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("surfaces preparation failure explicitly and keeps an empty catalog", async () => {
		const registry = ModelRegistry.create(AuthStorage.inMemory(), []);
		registry.registerProvider("required", requiredConfig(async () => { throw new Error("authoritative discovery failed"); }));
		await assert.rejects(() => registry.prepareRequiredProviders(), /authoritative discovery failed/u);
		assert.deepEqual(registry.getAll().filter((model) => model.provider === "required"), []);
	});

	test("an unconfigured required provider remains authoritatively unavailable without network work", async () => {
		const registry = ModelRegistry.create(AuthStorage.inMemory(), []);
		let calls = 0;
		const config = requiredConfig(async () => { calls += 1; return [preparedModel]; });
		delete config.apiKey;
		registry.registerProvider("required", config);
		await registry.prepareRequiredProviders();
		assert.equal(calls, 0);
		assert.deepEqual(registry.getAll().filter((model) => model.provider === "required"), []);
	});

	test("shared startup/SDK door prepares an already registered generation once with no pending registrations", async () => {
		const registry = ModelRegistry.create(AuthStorage.inMemory(), []);
		let calls = 0;
		registry.registerProvider("required", requiredConfig(async () => { calls += 1; return [preparedModel]; }));
		const extensions = { runtime: { pendingProviderRegistrations: [] as Array<{ name: string; config: ProviderConfigInput; extensionPath: string }> } };
		const resourceLoader = { getExtensions: () => extensions } as unknown as ResourceLoader;
		assert.deepEqual(await registerPendingProvidersAndPrepare(resourceLoader, registry, true), []);
		assert.equal(registry.resolveExactModel("required", "live").id, "live");
		assert.deepEqual(await registerPendingProvidersAndPrepare(resourceLoader, registry, true), []);
		assert.equal(calls, 1);
	});

	test("registers a pending required provider and prepares that generation", async () => {
		const registry = ModelRegistry.create(AuthStorage.inMemory(), []);
		const extensions = { runtime: { pendingProviderRegistrations: [
			{ name: "required", config: requiredConfig(async () => [preparedModel]), extensionPath: "test-extension.ts" },
		] } };
		const resourceLoader = { getExtensions: () => extensions } as unknown as ResourceLoader;
		assert.deepEqual(await registerPendingProvidersAndPrepare(resourceLoader, registry, true), []);
		assert.equal(extensions.runtime.pendingProviderRegistrations.length, 0);
		assert.equal(registry.resolveExactModel("required", "live").id, "live");
	});

	test("explicit missing host OAuth fails structurally while unrelated startup skips never-configured auth", async () => {
		const registry = ModelRegistry.create(AuthStorage.inMemory(), []);
		let calls = 0;
		registry.registerProvider("cursor", {
			...requiredConfig(async ({ hostCredential }) => {
				calls += 1;
				if (!hostCredential) throw new CursorError("AuthenticationMissing", "Cursor host OAuth credentials are required.", { operation: "authentication" });
				return [preparedModel];
			}),
			apiKey: undefined,
			requiresHostOAuth: true,
		});
		await registry.prepareRequiredProviders();
		assert.equal(calls, 0);
		await assert.rejects(registry.prepareRequiredProviders({ explicit: true }), (error: Error) =>
			error instanceof CursorError && error.code === "AuthenticationMissing");
		assert.equal(calls, 1);
	});

	test("configured non-OAuth host auth fails structurally instead of looking never configured", async () => {
		const registry = ModelRegistry.create(AuthStorage.inMemory({ cursor: { type: "api_key", key: "wrong-path" } }), []);
		let calls = 0;
		registry.registerProvider("cursor", {
			...requiredConfig(async () => { calls += 1; return [preparedModel]; }),
			requiresHostOAuth: true,
		});
		await assert.rejects(registry.prepareRequiredProviders(), (error: Error) =>
			error instanceof ProviderModelSelectionError && error.code === "AuthenticationMissing");
		assert.equal(calls, 0);
	});

	test("superseded preparation rejects before the current authoritative empty settles", async () => {
		const registry = ModelRegistry.create(AuthStorage.inMemory(), []);
		const resolvers: Array<(models: NonNullable<ProviderConfigInput["models"]>) => void> = [];
		registry.registerProvider("required", requiredConfig(() => new Promise((resolve) => resolvers.push(resolve))));
		const stale = registry.prepareRequiredProviders();
		await waitFor(() => resolvers.length === 1);
		const current = registry.prepareRequiredProviders();
		await waitFor(() => resolvers.length === 2);
		let currentSettled = false;
		void current.finally(() => { currentSettled = true; });
		resolvers[0]?.([preparedModel]);
		await assert.rejects(stale, /superseded/u);
		assert.equal(currentSettled, false);
		assert.deepEqual(registry.getAll().filter((model) => model.provider === "required"), []);
		resolvers[1]?.([]);
		await current;
		assert.deepEqual(registry.getAll().filter((model) => model.provider === "required"), []);
	});

	test("logout followed by provider re-registration preserves authenticated history", async () => {
		const auth = AuthStorage.inMemory({ cursor: { type: "oauth", access: "account", refresh: "account-refresh", expires: Date.now() + 60_000 } });
		const registry = ModelRegistry.create(auth, []);
		let calls = 0;
		const cursorConfig = {
			...requiredConfig(async () => { calls += 1; return [preparedModel]; }),
			requiresHostOAuth: true,
		};
		registry.registerProvider("cursor", cursorConfig);
		await registry.prepareRequiredProviders();
		assert.equal(calls, 1);
		auth.remove("cursor");
		registry.registerProvider("cursor", cursorConfig);
		await assert.rejects(registry.prepareRequiredProviders(), (error: Error) =>
			error instanceof ProviderModelSelectionError && error.code === "AuthenticationMissing");
		assert.equal(calls, 1);
	});

	test("required to ordinary re-registration retains rows for an empty ordinary model list", async () => {
		const registry = ModelRegistry.create(AuthStorage.inMemory(), []);
		registry.registerProvider("transition", requiredConfig(async () => [preparedModel]));
		await registry.prepareRequiredProviders();
		assert.equal(registry.resolveExactModel("transition", "live").id, "live");
		registry.registerProvider("transition", {
			name: "Ordinary", requiresPreparation: false, refreshModels: undefined, models: [],
		});
		assert.equal(registry.requiresProviderPreparation("transition"), false);
		assert.equal(registry.resolveExactModel("transition", "live").id, "live");
	});

	test("partial required re-registration keeps an explicit empty catalog authoritative", async () => {
		const registry = ModelRegistry.create(AuthStorage.inMemory(), []);
		registry.registerProvider("partial-required", requiredConfig(async () => [preparedModel]));
		await registry.prepareRequiredProviders();
		assert.equal(registry.resolveExactModel("partial-required", "live").id, "live");
		registry.registerProvider("partial-required", { name: "Still required", models: [] });
		assert.equal(registry.requiresProviderPreparation("partial-required"), true);
		assert.deepEqual(registry.getAll().filter((model) => model.provider === "partial-required"), []);
	});

	test("ordinary provider retains readable models when refresh or re-registration returns empty", async () => {
		const registry = ModelRegistry.create(AuthStorage.inMemory(), []);
		let resolveRefresh: ((models: NonNullable<ProviderConfigInput["models"]>) => void) | undefined;
		const ordinary = {
			...requiredConfig(() => new Promise((resolve) => { resolveRefresh = resolve; })),
			requiresPreparation: false,
			models: [preparedModel],
		};
		registry.registerProvider("ordinary", ordinary);
		const refreshing = registry.refresh();
		await waitFor(() => resolveRefresh !== undefined);
		assert.deepEqual(registry.getAll().filter((model) => model.provider === "ordinary").map((model) => model.id), ["live"]);
		resolveRefresh?.([]);
		await refreshing;
		assert.deepEqual(registry.getAll().filter((model) => model.provider === "ordinary").map((model) => model.id), ["live"]);
		registry.registerProvider("ordinary", { ...ordinary, refreshModels: undefined, models: [] });
		assert.deepEqual(registry.getAll().filter((model) => model.provider === "ordinary").map((model) => model.id), ["live"]);
	});

	test("credential-superseded preparation rejects and the replacement generation prepares", async () => {
		const first = { type: "oauth" as const, access: "first", refresh: "first-refresh", expires: Date.now() + 60_000 };
		const second = { type: "oauth" as const, access: "second", refresh: "second-refresh", expires: Date.now() + 60_000 };
		const auth = AuthStorage.inMemory({ required: first });
		const registry = ModelRegistry.create(auth, []);
		let resolveFirst: ((models: NonNullable<ProviderConfigInput["models"]>) => void) | undefined;
		let calls = 0;
		registry.registerProvider("required", {
			...requiredConfig(() => {
				calls += 1;
				return calls === 1 ? new Promise((resolve) => { resolveFirst = resolve; }) : Promise.resolve([preparedModel]);
			}),
			requiresHostOAuth: true,
		});
		const stale = registry.prepareRequiredProviders();
		await waitFor(() => resolveFirst !== undefined);
		auth.set("required", second);
		resolveFirst?.([preparedModel]);
		await assert.rejects(stale, /superseded/u);
		assert.deepEqual(registry.getAll().filter((model) => model.provider === "required"), []);
		await registry.prepareRequiredProviders();
		assert.equal(calls, 2);
		assert.deepEqual(registry.getAll().filter((model) => model.provider === "required").map((model) => model.id), ["live"]);
	});

	test("credential-superseded preparation preserves a structured stale-generation error", async () => {
		const auth = AuthStorage.inMemory({ required: { type: "oauth", access: "first", refresh: "first-refresh", expires: Date.now() + 60_000 } });
		const registry = ModelRegistry.create(auth, []);
		let rejectFirst: ((error: Error) => void) | undefined;
		registry.registerProvider("required", {
			...requiredConfig(() => new Promise((_, reject) => { rejectFirst = reject; })),
			requiresHostOAuth: true,
		});
		const stale = registry.prepareRequiredProviders();
		await waitFor(() => rejectFirst !== undefined);
		auth.set("required", { type: "oauth", access: "second", refresh: "second-refresh", expires: Date.now() + 60_000 });
		rejectFirst?.(new CursorError("StaleGeneration", "Credential generation was superseded.", { operation: "preparation" }));
		await assert.rejects(stale, (error: Error) =>
			error instanceof CursorError && error.code === "StaleGeneration" && error.operation === "preparation");
		assert.deepEqual(registry.getAll().filter((model) => model.provider === "required"), []);
	});
	test("runtime API key replacement invalidates an authoritative prepared catalog", async () => {
		const auth = AuthStorage.inMemory();
		auth.setRuntimeApiKey("required", "key-a");
		const registry = ModelRegistry.create(auth, []);
		let calls = 0;
		registry.registerProvider("required", requiredConfig(async ({ credential }) => {
			calls += 1;
			if (credential?.type !== "api_key" || !credential.key) throw new Error("expected runtime API key");
			return [{ ...preparedModel, id: credential.key }];
		}));
		await registry.prepareRequiredProviders({ explicit: true });
		assert.equal(registry.resolveExactModel("required", "key-a").id, "key-a");
		auth.setRuntimeApiKey("required", "key-b");
		await registry.prepareRequiredProviders({ explicit: true });
		assert.equal(calls, 2);
		assert.equal(registry.find("required", "key-a"), undefined);
		assert.equal(registry.resolveExactModel("required", "key-b").id, "key-b");
	});


});
