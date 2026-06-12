import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerCursorProvider } from "../../packages/cursor/src/provider.js";
import { CursorMockTransport } from "../../packages/cursor/src/transport.js";

type CursorHost = Parameters<typeof registerCursorProvider>[0];
type CursorConfig = Parameters<CursorHost["registerProvider"]>[1];

describe("Cursor provider registration", () => {
	test("registers Cursor as an experimental OAuth provider with estimated models and streamSimple", async () => {
		const registrations: { readonly name: string; readonly config: CursorConfig }[] = [];
		const shutdownHandlers: (() => Promise<void> | void)[] = [];
		const host: CursorHost = {
			registerProvider(name, config) {
				registrations.push({ name, config });
			},
			on(_event, handler) {
				shutdownHandlers.push(handler);
			},
		};

		const runtime = registerCursorProvider(host, { transport: new CursorMockTransport(), uuid: () => "request-1" });
		assert.equal(registrations.length, 1);
		assert.equal(registrations[0]?.name, "cursor");
		const config = registrations[0]?.config;
		assert.equal(config?.name, "Cursor");
		assert.equal(config?.oauth.name, "Cursor (experimental)");
		assert.equal(config?.api, "cursor-agent");
		assert.equal(typeof config?.streamSimple, "function");
		assert.ok(config?.models.some((model) => model.id === "composer-2" && /estimated/u.test(model.name)));
		assert.equal(shutdownHandlers.length, 1);
		await runtime.dispose();
	});

	test("host wiring includes bundled package copy and default model resolution", () => {
		const builtins = readFileSync("packages/coding-agent/src/core/builtin-packages.ts", "utf8");
		const copyScript = readFileSync("packages/coding-agent/scripts/copy-builtin-packages.ts", "utf8");
		const resolver = readFileSync("packages/coding-agent/src/core/model-resolver.ts", "utf8");
		assert.match(builtins, /@bastani\/cursor/u);
		assert.match(copyScript, /@bastani\/cursor/u);
		assert.match(resolver, /cursor:\s*"composer-2"/u);
	});
});
