import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import type { OAuthCredentials } from "@earendil-works/pi-ai/compat";
import type { CursorCatalogCache, CursorCatalogCacheQuery } from "../../packages/cursor/src/catalog-cache.js";
import type { CursorModelCatalog } from "../../packages/cursor/src/model-mapper.js";
import type { CursorDiscoveryService } from "../../packages/cursor/src/models.js";
import { registerCursorProvider, type CursorProviderConfig, type CursorProviderHost } from "../../packages/cursor/src/provider.js";
import { CursorMockTransport } from "./cursor-test-helpers.js";

const now = 1_000;
function token(): string {
	const encode = (value: object): string => Buffer.from(JSON.stringify(value)).toString("base64url");
	return `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ iss: "https://authentication.cursor.sh", sub: "auth0|account" })}.signature`;
}
class MemoryCache implements CursorCatalogCache {
	catalog: CursorModelCatalog | null = null;
	load(_query: CursorCatalogCacheQuery): CursorModelCatalog | null { return this.catalog; }
	save(catalog: CursorModelCatalog): void { this.catalog = catalog; }
}

describe("Cursor v2 provider registration", () => {
	test("registers empty and requires awaited authoritative preparation without background discovery", async () => {
		const registrations: CursorProviderConfig[] = [];
		const events: string[] = [];
		const host: CursorProviderHost = {
			registerProvider(_name, config) { registrations.push(config); },
			on(event) { events.push(event); },
		};
		let discoveries = 0;
		const discovery = {
			async discover() {
				discoveries += 1;
				return { fetchedAt: now, rows: [{ modelId: " exact ", maxMode: true }, { modelId: " exact ", maxMode: true }] };
			},
		} satisfies CursorDiscoveryService;
		const runtime = registerCursorProvider(host, {
			transport: new CursorMockTransport(),
			discoveryService: discovery,
			catalogCache: new MemoryCache(),
			now: () => now,
			uuid: () => "request",
			clientVersion: () => "client-v1",
		});
		const config = registrations[0];
		assert.ok(config);
		assert.deepEqual(config.models, []);
		assert.equal(config.requiresPreparation, true);
		assert.equal(discoveries, 0);
		assert.equal(events.includes("session_start"), false);
		const oauth: OAuthCredentials & { type: "oauth" } = { type: "oauth", access: token(), refresh: token(), expires: now + 10_000 };
		const models = await config.refreshModels({
			hostCredential: oauth,
			credentialGeneration: 3,
			providerInstanceGeneration: 2,
			allowNetwork: true,
		});
		assert.equal(discoveries, 1);
		assert.deepEqual(models.map((model) => model.id), [" exact ", " exact "]);
		assert.deepEqual(models.map((model) => model.providerReference.data.occurrence), [1, 2]);
		await runtime.dispose();
	});

	test("never accepts an API key credential as Cursor host authentication", async () => {
		let config: CursorProviderConfig | undefined;
		const runtime = registerCursorProvider({
			registerProvider(_name, value) { config = value; },
			on() {},
		}, { transport: new CursorMockTransport(), catalogCache: new MemoryCache(), now: () => now, uuid: () => "request" });
		assert.ok(config);
		await assert.rejects(config.refreshModels({
			hostCredential: { type: "api_key", key: "forbidden" },
			credentialGeneration: 1,
			providerInstanceGeneration: 1,
			allowNetwork: true,
		}), /host OAuth credentials are required/u);
		await runtime.dispose();
	});
});
