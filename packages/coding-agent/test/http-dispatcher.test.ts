import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { createHttpDispatcherOptions } from "../src/core/http-dispatcher.ts";
import { bunExecutable } from "./cli-test-helpers.ts";

/** Structural: starts Bun to exercise its ESM view of undici, which differs from Node's. */
const BUN_HTTP_SETUP_TIMEOUT_MS = 10_000;

describe("createHttpDispatcherOptions", () => {
	it("disables undici's default fixed connect timeout", () => {
		const options = createHttpDispatcherOptions(123_456);
		expect(options.allowH2).toBe(false);
		expect(options.connectTimeout).toBe(0);
		expect(options.bodyTimeout).toBe(123_456);
		expect(options.headersTimeout).toBe(123_456);
		// Pi sync: attach undici error-suppressing factories so mid-stream
		// client errors do not crash the process.
		expect(typeof options.clientFactory).toBe("function");
		expect(typeof options.factory).toBe("function");
	});

	it(
		"installs the configured undici fetch under Bun",
		() => {
			const moduleUrl = new URL("../src/core/http-dispatcher.ts", import.meta.url).href;
			const script = [
				`const originalFetch = globalThis.fetch;`,
				`const { configureHttpDispatcher } = await import(${JSON.stringify(moduleUrl)});`,
				`configureHttpDispatcher();`,
				`console.log(JSON.stringify({ replaced: globalThis.fetch !== originalFetch }));`,
			].join("\n");
			const child = spawnSync(bunExecutable(), ["--eval", script], {
				encoding: "utf8",
				timeout: BUN_HTTP_SETUP_TIMEOUT_MS,
			});

			expect(child.error).toBeUndefined();
			expect(child.status).toBe(0);
			expect(child.stderr).toBe("");
			expect(JSON.parse(child.stdout)).toEqual({ replaced: true });
		},
		BUN_HTTP_SETUP_TIMEOUT_MS,
	);
});
