import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveCursorCredentialScope, FileCursorCatalogCache } from "../../packages/cursor/src/catalog-cache.js";
import type { CursorModelCatalog } from "../../packages/cursor/src/model-mapper.js";
import type { CursorModelDiscoveryService } from "../../packages/cursor/src/models.js";
import { registerCursorProvider, type CursorProviderContext } from "../../packages/cursor/src/provider.js";
import { CursorMockTransport } from "./cursor-test-helpers.js";

type CursorHost = Parameters<typeof registerCursorProvider>[0];
type CursorConfig = Parameters<CursorHost["registerProvider"]>[1];
type CursorLifecycleHandler = (event?: unknown, context?: CursorProviderContext) => Promise<void> | void;

function jwtForSubject(subject: string, randomness: string): string {
	return `header.${Buffer.from(JSON.stringify({ sub: subject, randomness })).toString("base64url")}.signature`;
}

function makeHost(): {
	readonly host: CursorHost;
	readonly registrations: Array<{ readonly name: string; readonly config: CursorConfig }>;
	readonly lifecycleHandlers: Map<string, CursorLifecycleHandler[]>;
} {
	const registrations: Array<{ readonly name: string; readonly config: CursorConfig }> = [];
	const lifecycleHandlers = new Map<string, CursorLifecycleHandler[]>();
	return {
		registrations,
		lifecycleHandlers,
		host: {
			registerProvider: (name, config) => registrations.push({ name, config }),
			on: (event, handler) => lifecycleHandlers.set(event, [...lifecycleHandlers.get(event) ?? [], handler]),
		},
	};
}

describe("Cursor provider credential-scoped startup", () => {
	test("reuses only a fresh cache for the same stable account", async () => {
		const dir = mkdtempSync(join(tmpdir(), "atomic-cursor-scoped-cache-"));
		try {
			const accessToken = jwtForSubject("account-a", "first-token");
			const rotatedToken = jwtForSubject("account-a", "rotated-token");
			const scope = deriveCursorCredentialScope(accessToken);
			assert.ok(scope);
			const cache = new FileCursorCatalogCache(join(dir, "catalog.json"));
			cache.save({ source: "live", fetchedAt: 90, models: [{ id: "same-account", displayName: "Same Account" }] }, scope);
			let discoveryAttempts = 0;
			const discovery = {
				async discover(): Promise<CursorModelCatalog> {
					discoveryAttempts += 1;
					throw new Error("must not refresh fresh scoped cache");
				},
			} as unknown as CursorModelDiscoveryService;
			const { host, lifecycleHandlers, registrations } = makeHost();
			const runtime = registerCursorProvider(host, {
				transport: new CursorMockTransport(), discoveryService: discovery, catalogCache: cache,
				catalogCacheTtlMs: 100, now: () => 100, uuid: () => "scoped",
			});
			assert.equal(registrations.at(-1)?.config.models.some((model) => model.id === "same-account"), false);
			const handler = lifecycleHandlers.get("session_start")?.[0];
			assert.ok(handler);
			await handler({}, { mode: "print", modelRegistry: { getApiKeyForProvider: async () => rotatedToken } });
			assert.equal(discoveryAttempts, 0);
			assert.equal(registrations.at(-1)?.config.models.some((model) => model.id === "same-account"), true);
			await runtime.dispose();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
