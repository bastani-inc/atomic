import { test } from "bun:test";
import assert from "node:assert/strict";
import type { CursorCatalogCache } from "../../packages/cursor/src/catalog-cache.js";
import type { CursorModelCatalog } from "../../packages/cursor/src/model-mapper.js";
import {
	registerCursorProvider,
	type CursorProviderConfig,
	type CursorProviderEvent,
	type CursorProviderHost,
} from "../../packages/cursor/src/provider.js";
import { authenticatedFable5Model } from "./cursor-fable-test-fixture.js";
import { CursorMockTransport } from "./cursor-test-helpers.js";

class MemoryCatalogCache implements CursorCatalogCache {
	load(): CursorModelCatalog | null { return null; }
	save(): void {}
}

test("provider registry exposes Fable tuples as four stable selectable rows", async () => {
	const registrations: CursorProviderConfig[] = [];
	const handlers = new Map<CursorProviderEvent, Parameters<CursorProviderHost["on"]>[1]>();
	const host: CursorProviderHost = {
		registerProvider(_name, config) { registrations.push(config); },
		on(event, handler) { handlers.set(event, handler); },
	};
	const runtime = registerCursorProvider(host, {
		transport: new CursorMockTransport({ models: [authenticatedFable5Model()] }),
		catalogCache: new MemoryCatalogCache(),
		now: () => 100,
		uuid: () => "fable-discovery",
	});
	const start = handlers.get("session_start");
	assert.ok(start);
	await start({}, { modelRegistry: { getApiKeyForProvider: async () => "stored-access" } });
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
	const models = registrations.at(-1)?.models ?? [];
	assert.deepEqual(models.map(({ id, name }) => ({ id, name })), [
		{ id: "claude-fable-5-1m-max", name: "Fable 5 (1M, Max)" },
		{ id: "claude-fable-5-1m-max-thinking", name: "Fable 5 (1M, Max, Thinking)" },
		{ id: "claude-fable-5-300k", name: "Fable 5 (300K)" },
		{ id: "claude-fable-5-300k-thinking", name: "Fable 5 (300K, Thinking)" },
	]);
	assert.ok(models[0]?.compat?.cursorModelAliases?.includes("claude-fable-5-context-1m-max-mode-low"));
	await runtime.dispose();
});
