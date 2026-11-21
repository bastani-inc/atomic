import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test, vi } from "vitest";
import { settingsEnvironmentForEarlyChild } from "../src/utils/startup-environment.ts";

const tempDirs: string[] = [];

afterEach(() => {
	vi.unstubAllEnvs();
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function agentDirWith(settings: string | undefined): string {
	const dir = mkdtempSync(join(tmpdir(), "startup-environment-"));
	tempDirs.push(dir);
	if (settings !== undefined) writeFileSync(join(dir, "settings.json"), settings);
	return dir;
}

describe("the settings environment of an engine child started before main() loads the settings", () => {
	test("gives the child the proxy and debug setting while this process's environment stays as it was", async () => {
		for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ATOMIC_DEBUG_SETTING"]) vi.stubEnv(name, undefined);
		const env = await settingsEnvironmentForEarlyChild(
			agentDirWith(`\uFEFF${JSON.stringify({ debug: true, httpProxy: "  http://proxy.test:3128  " })}`),
		);
		assert.deepEqual(env, {
			ATOMIC_DEBUG_SETTING: "1",
			HTTP_PROXY: "http://proxy.test:3128",
			HTTPS_PROXY: "http://proxy.test:3128",
		});
		// main() applies the settings it loads itself, so a file changed meanwhile is never applied here from this read.
		assert.equal(process.env.HTTP_PROXY, undefined);
		assert.equal(process.env.HTTPS_PROXY, undefined);
		assert.equal(process.env.ATOMIC_DEBUG_SETTING, undefined);
	});

	test("keeps a proxy the environment names, and a debug setting a parent passed down", async () => {
		vi.stubEnv("HTTP_PROXY", "http://user.test:8080");
		vi.stubEnv("HTTPS_PROXY", undefined);
		vi.stubEnv("ATOMIC_DEBUG_SETTING", "0");
		const env = await settingsEnvironmentForEarlyChild(
			agentDirWith(JSON.stringify({ debug: true, httpProxy: "http://proxy.test:3128" })),
		);
		assert.deepEqual(env, { HTTPS_PROXY: "http://proxy.test:3128" });
	});

	test("reads values of the wrong type, and a missing or unparsable file, as no setting", async () => {
		for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ATOMIC_DEBUG_SETTING"]) vi.stubEnv(name, undefined);
		assert.deepEqual(
			await settingsEnvironmentForEarlyChild(agentDirWith(JSON.stringify({ debug: "true", httpProxy: 3128 }))),
			{ ATOMIC_DEBUG_SETTING: "0" },
		);
		assert.deepEqual(await settingsEnvironmentForEarlyChild(agentDirWith(JSON.stringify({ httpProxy: "  " }))), {
			ATOMIC_DEBUG_SETTING: "0",
		});
		assert.deepEqual(await settingsEnvironmentForEarlyChild(agentDirWith(undefined)), {});
		assert.deepEqual(await settingsEnvironmentForEarlyChild(agentDirWith("{ not json")), {});
		assert.deepEqual(await settingsEnvironmentForEarlyChild(agentDirWith("[]")), {});
	});
});
