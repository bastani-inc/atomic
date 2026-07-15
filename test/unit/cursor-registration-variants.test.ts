import { test } from "bun:test";
import assert from "node:assert/strict";
import type { CursorCatalogCache } from "../../packages/cursor/src/catalog-cache.js";
import type { CursorModelCatalog } from "../../packages/cursor/src/model-mapper.js";
import { CursorModelDiscoveryService } from "../../packages/cursor/src/models.js";
import { registerCursorProvider, type CursorProviderContext, type CursorProviderHost } from "../../packages/cursor/src/provider.js";
import { CursorMockTransport } from "./cursor-test-helpers.js";

class MemoryCatalogCache implements CursorCatalogCache {
	load(): CursorModelCatalog | null { return null }
	save(): void {}
}

class TestCursorDiscoveryService extends CursorModelDiscoveryService {
	constructor() {
		super({ transport: new CursorMockTransport() });
	}

	override async discover(): Promise<CursorModelCatalog> {
		return {
			source: "live",
			fetchedAt: 1,
			models: [
				{ id: "cursor-grok-4.5-high", displayName: "Grok High", maxMode: true },
				{ id: "claude-fable-5-1m-max", displayName: "Fable Max", maxMode: true },
			],
		};
	}
}

test("provider starts with no executable static routes and registers exact authenticated rows", async () => {
	const registrations: Array<{ readonly models: readonly { readonly id: string; readonly reasoning: boolean; readonly compat?: object }[] }> = [];
	const handlers = new Map<string, (event?: unknown, context?: CursorProviderContext) => Promise<void> | void>();
	const host: CursorProviderHost = {
		registerProvider(_name, config) { registrations.push(config) },
		on(event, handler) { handlers.set(event, handler) },
	};
	const discovery = new TestCursorDiscoveryService();
	const runtime = registerCursorProvider(host, {
		transport: new CursorMockTransport(),
		discoveryService: discovery,
		catalogCache: new MemoryCatalogCache(),
		uuid: () => "request",
	});

	assert.deepEqual(registrations[0]?.models, []);
	const discover = handlers.get("model_catalog_discover");
	assert.ok(discover);
	await discover(
		{ type: "model_catalog_discover" },
		{ modelRegistry: { getApiKeyForProvider: async () => "stored-access" } },
	);
	const models = registrations.at(-1)?.models ?? [];
	assert.deepEqual(models.map((model) => model.id), ["cursor-grok-4.5-high", "claude-fable-5-1m-max"]);
	assert.ok(models.every((model) => model.reasoning === false));
	assert.ok(models.every((model) => !("cursorModelAliases" in (model.compat ?? {}))));
	await runtime.dispose();
});
