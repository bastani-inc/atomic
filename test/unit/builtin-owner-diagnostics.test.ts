import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { join } from "node:path";
import type { HostDiagnostic } from "@bastani/atomic";
import { test, vi } from "vitest";
import { makeTempDirectory, removeTempDirectory, writeFileEnsuringDir } from "../helpers/runtime.js";

const config = vi.hoisted(() => ({ path: "" }));
vi.mock("../../packages/web-access/config-paths.ts", () => ({
	findReadableConfigPath: () => config.path,
	EXA_USAGE_PATH: "",
}));

// #3105: configuration/storage failures report to their invocation owner without raw secrets.
test("builtin configuration diagnostics are quiet, redacted and routed to each owner", async () => {
	const directory = makeTempDirectory("builtin-diagnostics-");
	config.path = join(directory, "secret-config.json");
	await writeFileEnsuringDir(config.path, "secret-supervisor-capability");
	await writeFileEnsuringDir(join(directory, "intercom", "config.json"), "secret-intercom-token");
	vi.stubEnv("ATOMIC_CODING_AGENT_DIR", directory);
	const key = Symbol.for("atomic.builtin-diagnostic-context.v1");
	type Reporter = (diagnostic: Omit<HostDiagnostic, "sessionId">) => void;
	const host = globalThis as typeof globalThis & { [key]?: AsyncLocalStorage<Reporter> };
	const previous = host[key];
	const context = new AsyncLocalStorage<Reporter>();
	host[key] = context;
	const errors = vi.spyOn(console, "error").mockImplementation(() => {});
	try {
		const { loadConfigForExtensionInit } = await import("../../packages/web-access/web-search-config.js");
		const { loadConfig } = await import("../../packages/intercom/config.js");
		for (let index = 0; index < 2; index++) {
			const diagnostics: Omit<HostDiagnostic, "sessionId">[] = [];
			context.run(
				(entry) => diagnostics.push(entry),
				() => {
					loadConfigForExtensionInit();
					loadConfig();
				},
			);
			assert.deepEqual(
				diagnostics.map((entry) => entry.source),
				["web-access", "intercom"],
			);
			assert.doesNotMatch(JSON.stringify(diagnostics), /secret|capability|credential|token/);
		}
		assert.equal(errors.mock.calls.length, 0);
	} finally {
		errors.mockRestore();
		host[key] = previous;
		vi.unstubAllEnvs();
		removeTempDirectory(directory);
	}
});
