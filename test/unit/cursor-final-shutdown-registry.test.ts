import { test } from "bun:test";
import assert from "node:assert/strict";
import { AuthStorage } from "../../packages/coding-agent/src/core/auth-storage.js";
import { ModelRegistry } from "../../packages/coding-agent/src/core/model-registry.js";
import { trustedCursorProviderSource } from "../../packages/coding-agent/test/cursor-test-provider-source.js";
import type { CursorModelCatalog } from "../../packages/cursor/src/model-mapper.js";
import { registerCursorProvider, type CursorProviderContext, type CursorProviderEvent, type CursorProviderHost } from "../../packages/cursor/src/provider.js";
import { CursorMockTransport } from "./cursor-test-helpers.js";

const token = `x.${Buffer.from(JSON.stringify({ sub: "final-shutdown" })).toString("base64url")}.x`;
type Handler = (event?: unknown, context?: CursorProviderContext) => Promise<void> | void;

test("final shutdown removes live Cursor registry rows while suppressing teardown refresh errors", async () => {
	const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
	const handlers = new Map<CursorProviderEvent, Handler>();
	let rejectEmptyRefresh = false;
	const host: CursorProviderHost = {
		registerProvider(name, config) {
			registry.registerProvider(name, { ...config, models: config.models.map((model) => ({ ...model, input: [...model.input], cost: { ...model.cost }, compat: model.compat as never })) }, trustedCursorProviderSource());
			if (rejectEmptyRefresh && config.models.length === 0) throw new Error("selected occurrence removed during teardown");
		},
		on(event, handler) { handlers.set(event, handler); },
	};
	const catalog: CursorModelCatalog = {
		source: "live", fetchedAt: 1, models: [{ id: "live-before-quit", maxMode: false }],
	};
	registerCursorProvider(host, {
		transport: new CursorMockTransport(),
		discoveryService: { discover: async () => catalog } as never,
		catalogCache: { load: () => null, save: () => true, clear() {} },
		now: () => 1,
	});
	const discover = handlers.get("model_catalog_discover");
	assert.ok(discover);
	await discover({}, { mode: "print", modelRegistry: { getApiKeyForProvider: async () => token } });
	assert.equal(registry.find("cursor", "live-before-quit")?.id, "live-before-quit");

	rejectEmptyRefresh = true;
	const shutdown = handlers.get("session_shutdown");
	assert.ok(shutdown);
	await shutdown({ type: "session_shutdown", reason: "quit" });
	assert.equal(registry.find("cursor", "live-before-quit"), undefined);
	assert.equal(registry.getAll().some((model) => model.provider === "cursor"), false);
});
